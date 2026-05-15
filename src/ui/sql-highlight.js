// SQL syntax highlighter built on top of the project's tokenizer.
//
// Used in two places:
//   1. `renderSqlAsNodes(sql)` — for static rendering inside markdown
//      `<pre><code>` blocks and the "show reference answer" panel.
//   2. `renderSqlAsHtml(sql)` — string output used by the live editor
//      overlay (`createHighlightedEditor`) where DOM construction is
//      cheaper as innerHTML.
//
// On tokenizer error we degrade gracefully to plain text so a half-typed
// query keeps showing characters as the user types — the alternative
// would be a flickering empty overlay every keystroke.

import { tokenize } from '../sql/tokenizer.js';

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/**
 * Map a token type to a CSS class. The tokenizer emits 7 distinct
 * types — we group them into the small set of CSS classes the stylesheet
 * knows about.
 */
function classFor(type) {
  switch (type) {
    case 'keyword':     return 'sql-kw';
    case 'string':      return 'sql-str';
    case 'number':      return 'sql-num';
    case 'comment':     return 'sql-com';
    case 'identifier':  return 'sql-id';
    case 'operator':    return 'sql-op';
    case 'punctuation': return 'sql-punc';
    default:            return null;
  }
}

/**
 * Tokenize a SQL string and emit DOM nodes with class names that the
 * stylesheet renders in different colours. Whitespace tokens stay as
 * plain text nodes so spacing is preserved exactly.
 *
 * @param {string} sql
 * @returns {Node[]}
 */
export function renderSqlAsNodes(sql) {
  /** @type {Node[]} */
  const out = [];
  let tokens;
  try {
    tokens = tokenize(sql);
  } catch {
    out.push(document.createTextNode(String(sql ?? '')));
    return out;
  }

  for (const t of tokens) {
    const cls = classFor(t.type);
    // For tokens whose value is normalised (e.g. keywords are uppercased
    // by the tokenizer) we MUST emit the original substring of the source
    // so identifiers like `Order_Date` keep their casing.
    const slice = sql.slice(t.start, t.end);
    if (cls === null) {
      out.push(document.createTextNode(slice));
      continue;
    }
    const span = document.createElement('span');
    span.className = cls;
    span.appendChild(document.createTextNode(slice));
    out.push(span);
  }
  return out;
}

/**
 * Same idea as `renderSqlAsNodes`, but emits a single innerHTML string.
 * Used by the live editor overlay where every keystroke replaces the
 * overlay's HTML — DOM diffing here would be more expensive than a
 * single innerHTML write.
 *
 * @param {string} sql
 * @returns {string}
 */
export function renderSqlAsHtml(sql) {
  let tokens;
  try {
    tokens = tokenize(sql);
  } catch {
    return escape(sql ?? '');
  }
  let html = '';
  for (const t of tokens) {
    const cls = classFor(t.type);
    const slice = sql.slice(t.start, t.end);
    if (cls === null) {
      html += escape(slice);
    } else {
      html += `<span class="${cls}">${escape(slice)}</span>`;
    }
  }
  return html;
}

export default { renderSqlAsNodes, renderSqlAsHtml };
