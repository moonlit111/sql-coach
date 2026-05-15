// Minimal Markdown → DOM renderer for the Tutor view.
//
// Why a custom renderer:
//   - The Tutor agent emits Chinese/English Markdown with fenced code
//     blocks (often SQL). The previous implementation set the message
//     body as plain text, which dropped headings, bullet lists and
//     wrapped code in a paragraph.
//   - Pulling in a 50KB Markdown library through esm.sh would defeat
//     the project's "no build, tiny deps" goal. The Tutor messages are
//     short enough that ~120 lines of regex-based parsing covers
//     headings, paragraphs, lists, bold/italic, inline code, links,
//     fenced code blocks, and HTML escaping.
//   - The renderer plugs into the SQL tokenizer for syntax-highlighted
//     code fences when the language is `sql`.

import { el } from './dom.js';
import { renderSqlAsNodes } from './sql-highlight.js';

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/**
 * Render a Markdown source string into a DOM container. Returns the
 * container element so callers can append it directly into a parent.
 *
 * Supports: ATX headings (#..######), unordered lists (- / * / +),
 * fenced code blocks (```lang\n...\n```), inline code, **bold**, *italic*,
 * [text](url), paragraphs separated by blank lines.
 *
 * @param {string} md
 * @returns {HTMLElement}
 */
export function renderMarkdown(md) {
  const container = el('div', { class: 'markdown' });
  if (typeof md !== 'string' || md.trim() === '') return container;

  // Split into blocks separated by blank lines, but preserve fenced code
  // blocks as single blocks even if they contain blank lines.
  const blocks = splitIntoBlocks(md);

  for (const block of blocks) {
    if (block.kind === 'code') {
      container.appendChild(renderCodeBlock(block.lang, block.body));
      continue;
    }
    const text = block.body.trim();
    if (text === '') continue;

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(text);
    if (h) {
      const level = h[1].length;
      container.appendChild(el(`h${level}`, { class: 'md-heading' }, ...renderInline(h[2])));
      continue;
    }

    // Unordered list — every line starts with - / * / +
    const lines = text.split(/\r?\n/);
    if (lines.every((ln) => /^\s*[-*+]\s+/.test(ln))) {
      container.appendChild(
        el('ul', { class: 'md-list' },
          ...lines.map((ln) => {
            const m = /^\s*[-*+]\s+(.*)$/.exec(ln);
            return el('li', {}, ...renderInline(m ? m[1] : ln));
          }),
        ),
      );
      continue;
    }

    // Ordered list — every line "1. xxx"
    if (lines.every((ln) => /^\s*\d+\.\s+/.test(ln))) {
      container.appendChild(
        el('ol', { class: 'md-list' },
          ...lines.map((ln) => {
            const m = /^\s*\d+\.\s+(.*)$/.exec(ln);
            return el('li', {}, ...renderInline(m ? m[1] : ln));
          }),
        ),
      );
      continue;
    }

    // Blockquote — every line starts with `> `
    if (lines.every((ln) => /^\s*>\s?/.test(ln))) {
      const inner = lines.map((ln) => ln.replace(/^\s*>\s?/, '')).join('\n');
      container.appendChild(el('blockquote', { class: 'md-quote' }, ...renderInline(inner)));
      continue;
    }

    // Default: paragraph. Single newlines become <br> within a paragraph.
    const p = el('p', { class: 'md-p' });
    const parts = lines.map((ln, i) => [
      ...renderInline(ln),
      i < lines.length - 1 ? el('br') : null,
    ].filter(Boolean));
    for (const part of parts) for (const node of part) p.appendChild(node);
    container.appendChild(p);
  }

  return container;
}

/**
 * Split a markdown string into ordered blocks of either prose or fenced
 * code, preserving the original line breaks within each block.
 *
 * @param {string} md
 * @returns {Array<{kind:'prose'|'code', body:string, lang?:string}>}
 */
function splitIntoBlocks(md) {
  /** @type {Array<{kind:'prose'|'code', body:string, lang?:string}>} */
  const blocks = [];
  const lines = md.split(/\r?\n/);
  /** @type {string[]} */
  let buf = [];
  let i = 0;
  while (i < lines.length) {
    const fence = /^```(\w*)\s*$/.exec(lines[i]);
    if (fence) {
      // Flush prose first
      if (buf.length) { pushProseSplit(blocks, buf.join('\n')); buf = []; }
      const lang = fence[1] || '';
      const start = i + 1;
      let end = start;
      while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;
      blocks.push({ kind: 'code', lang, body: lines.slice(start, end).join('\n') });
      i = end + 1;
      continue;
    }
    buf.push(lines[i]);
    i++;
  }
  if (buf.length) pushProseSplit(blocks, buf.join('\n'));
  return blocks;
}

/**
 * Split prose into paragraphs separated by ≥1 blank lines.
 */
function pushProseSplit(blocks, prose) {
  for (const para of prose.split(/\n{2,}/)) {
    if (para.trim() === '') continue;
    blocks.push({ kind: 'prose', body: para });
  }
}

/**
 * Render a fenced code block. SQL gets syntax-highlighted via the shared
 * tokenizer; everything else is plain `<pre><code>`.
 *
 * @param {string} lang
 * @param {string} body
 */
function renderCodeBlock(lang, body) {
  const lower = (lang || '').toLowerCase();
  if (lower === 'sql' || lower === 'mysql' || lower === 'sqlite') {
    const pre = el('pre', { class: 'md-code md-code-sql' });
    const code = el('code', {});
    for (const node of renderSqlAsNodes(body)) code.appendChild(node);
    pre.appendChild(code);
    return pre;
  }
  return el('pre', { class: 'md-code' }, el('code', {}, body));
}

/**
 * Inline pass — `code`, **bold**, *italic*, [text](url), bare URLs.
 * Returns an array of DOM nodes (text + small wrappers).
 *
 * @param {string} text
 * @returns {Node[]}
 */
function renderInline(text) {
  /** @type {Node[]} */
  const out = [];
  let i = 0;
  let buf = '';
  const flushText = () => {
    if (buf !== '') {
      out.push(document.createTextNode(buf));
      buf = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Inline `code`
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flushText();
        out.push(el('code', { class: 'md-inline-code' }, text.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }

    // **bold**
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        flushText();
        out.push(el('strong', {}, ...renderInline(text.slice(i + 2, end))));
        i = end + 2;
        continue;
      }
    }

    // *italic*
    if (ch === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1 && end > i + 1) {
        flushText();
        out.push(el('em', {}, ...renderInline(text.slice(i + 1, end))));
        i = end + 1;
        continue;
      }
    }

    // [text](url)
    if (ch === '[') {
      const close = text.indexOf(']', i + 1);
      if (close !== -1 && text[close + 1] === '(') {
        const urlEnd = text.indexOf(')', close + 2);
        if (urlEnd !== -1) {
          flushText();
          const label = text.slice(i + 1, close);
          const url = sanitizeMarkdownUrl(text.slice(close + 2, urlEnd));
          if (url) {
            out.push(el('a', { href: url, rel: 'noopener noreferrer', target: '_blank' }, label));
          } else {
            out.push(document.createTextNode(label));
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flushText();
  return out;
}

export default renderMarkdown;

// Re-export for tests that want the escape helper without depending on DOM.
export { escapeHtml };

/**
 * Keep model-authored Markdown links inert unless they point to a normal web
 * URL or a local relative URL. This blocks `javascript:` / `data:` payloads
 * while still allowing documentation links in Tutor answers.
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeMarkdownUrl(raw) {
  const url = String(raw ?? '').trim();
  if (url === '') return '';
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^(#|\/(?!\/)|\.{1,2}\/)/.test(url)) return url;
  return '';
}
