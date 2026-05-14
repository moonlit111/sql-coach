// SQL pretty-printer over the original token stream.
// Preserves token order and casing of identifiers/strings; only keywords are
// uppercased (already enforced by the tokenizer).
//
// Round-trip property: parse(format(parse(s))) must equal parse(s) on every
// flag field. Because the parser's flag detection is whitespace-insensitive
// and operates on the token stream, any formatter that re-emits the same
// non-whitespace token sequence satisfies the property.

import { tokenize } from './tokenizer.js';

const TOP_CLAUSE = new Set([
  'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT',
  'UNION', 'INTERSECT', 'EXCEPT',
]);
const TWO_WORD_TOP = new Map([
  ['GROUP', 'BY'],
  ['ORDER', 'BY'],
]);

const MAX_INDENT_LEVEL = 4; // cap to avoid runaway indentation

/**
 * Format a SQL string or an AST (with .tokens) into a pretty-printed SQL string.
 * @param {string | { tokens: Array }} astOrSql
 * @returns {string}
 */
export function format(astOrSql) {
  let tokens;
  if (typeof astOrSql === 'string') {
    try {
      tokens = tokenize(astOrSql);
    } catch {
      return astOrSql;
    }
  } else if (astOrSql && Array.isArray(astOrSql.tokens)) {
    tokens = astOrSql.tokens;
  } else {
    return '';
  }
  return renderFromTokens(tokens);
}

/**
 * Render a token stream as a formatted SQL string.
 * @param {Array} tokensIn
 * @returns {string}
 */
function renderFromTokens(tokensIn) {
  // Filter out whitespace/comment tokens; we re-emit our own whitespace.
  const tokens = tokensIn.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
  if (tokens.length === 0) return '';

  // Track indentation by paren depth, but only count parens that wrap a SELECT
  // as "subquery" indents. For simple parens, indent stays the same.
  // We keep a small stack of {wrapsSelect: boolean} per open paren.
  const parenStack = [];
  let out = '';
  let atLineStart = true;
  let firstEmitted = false;

  const indentStr = () => {
    let depth = 0;
    for (const p of parenStack) if (p.wrapsSelect) depth++;
    if (depth > MAX_INDENT_LEVEL) depth = MAX_INDENT_LEVEL;
    return '  '.repeat(depth);
  };

  const newline = () => {
    if (!firstEmitted) return; // never lead with a newline
    if (out.length > 0 && out[out.length - 1] !== '\n') out += '\n';
    out += indentStr();
    atLineStart = true;
  };

  const emitRaw = (s) => {
    out += s;
    if (s.length > 0) atLineStart = s.endsWith('\n');
  };

  const needsSpaceBefore = (tok) => {
    if (atLineStart) return false;
    if (out.length === 0) return false;
    const last = out[out.length - 1];
    if (last === ' ' || last === '\n' || last === '(' || last === '.') return false;
    if (tok.type === 'punctuation') {
      if (tok.value === ',' || tok.value === ';' || tok.value === ')' || tok.value === '.') return false;
    }
    return true;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];

    // Closing paren — pop and emit
    if (t.type === 'punctuation' && t.value === ')') {
      const top = parenStack.pop();
      if (top && top.wrapsSelect) {
        // close on its own line at the new (outer) indent
        if (out.length > 0 && out[out.length - 1] !== '\n') out += '\n';
        out += indentStr();
      }
      out += ')';
      atLineStart = false;
      firstEmitted = true;
      continue;
    }

    // Opening paren — peek ahead to decide if it wraps a SELECT subquery
    if (t.type === 'punctuation' && t.value === '(') {
      let wrapsSelect = false;
      // skip nested ( to find first significant token
      for (let j = i + 1; j < tokens.length; j++) {
        const tt = tokens[j];
        if (tt.type === 'punctuation' && tt.value === '(') continue;
        if (tt.type === 'keyword' && tt.value === 'SELECT') wrapsSelect = true;
        break;
      }
      if (needsSpaceBefore(t)) emitRaw(' ');
      out += '(';
      atLineStart = false;
      firstEmitted = true;
      parenStack.push({ wrapsSelect });
      if (wrapsSelect) {
        out += '\n';
        out += indentStr();
        atLineStart = true;
      }
      continue;
    }

    // Comma — hang onto next line
    if (t.type === 'punctuation' && t.value === ',') {
      out += ',';
      out += '\n';
      out += indentStr();
      // extra two spaces of hanging indent
      out += '  ';
      atLineStart = false;
      firstEmitted = true;
      continue;
    }

    // Top-level clause keywords — newline before
    if (t.type === 'keyword' && TOP_CLAUSE.has(t.value)) {
      newline();
      out += t.value;
      atLineStart = false;
      firstEmitted = true;
      continue;
    }

    // Two-word top-level (GROUP BY, ORDER BY)
    if (
      t.type === 'keyword' &&
      TWO_WORD_TOP.has(t.value) &&
      next?.type === 'keyword' &&
      next.value === TWO_WORD_TOP.get(t.value)
    ) {
      newline();
      out += `${t.value} ${next.value}`;
      atLineStart = false;
      firstEmitted = true;
      i++; // consumed the second word
      continue;
    }

    // Default: emit token value with leading space if needed
    if (needsSpaceBefore(t)) out += ' ';
    out += t.value;
    atLineStart = false;
    firstEmitted = true;
  }

  return out;
}
