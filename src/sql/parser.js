// Coarse SQL parser: classifies statement kind and detects structural flags.
// Never throws; returns { error } on failure.

import { tokenize, stripNoise } from './tokenizer.js';
import { emptyAst } from './ast.js';

const DDL_LEAD = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'ATTACH', 'DETACH', 'PRAGMA']);
const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

/**
 * @param {string} sql
 * @returns {import('./ast.js').SqlAst | { error: string }}
 */
export function parse(sql) {
  if (typeof sql !== 'string') return { error: 'sql must be a string' };
  let tokens;
  try {
    tokens = tokenize(sql);
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
  const sig = stripNoise(tokens);
  if (sig.length === 0) return { error: 'empty input' };

  const ast = emptyAst();
  ast.tokens = tokens;

  const lead = sig[0];

  // Allow a leading "(" before SELECT to still classify the statement as SELECT
  // (handles `(SELECT ...) UNION (SELECT ...)`).
  let leadKw = null;
  if (lead.type === 'keyword') {
    leadKw = lead.value;
  } else if (lead.type === 'punctuation' && lead.value === '(') {
    for (let i = 1; i < sig.length; i++) {
      const t = sig[i];
      if (t.type === 'punctuation' && t.value === '(') continue;
      if (t.type === 'keyword') { leadKw = t.value; break; }
      break;
    }
  }

  if (leadKw == null) {
    ast.kind = 'OTHER';
  } else if (DDL_LEAD.has(leadKw)) ast.kind = 'DDL';
  else if (leadKw === 'SELECT') ast.kind = 'SELECT';
  else if (leadKw === 'INSERT') ast.kind = 'INSERT';
  else if (leadKw === 'UPDATE') ast.kind = 'UPDATE';
  else if (leadKw === 'DELETE') ast.kind = 'DELETE';
  else if (leadKw === 'REPLACE') ast.kind = 'REPLACE';
  else ast.kind = 'OTHER';

  // Whole-stream scan for flags. Token-aware: string literals are already separate
  // tokens by the tokenizer, so e.g. `'DROP TABLE'` does not yield a DROP keyword token.
  let parenDepth = 0;
  /** @type {string[]} */
  const tableRefs = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    const next = sig[i + 1];

    if (t.type === 'punctuation') {
      if (t.value === '(') parenDepth++;
      else if (t.value === ')') parenDepth--;
      continue;
    }
    if (t.type === 'identifier') {
      const ident = normaliseIdentifier(t.value).toUpperCase();
      if (AGGREGATES.has(ident) && next?.type === 'punctuation' && next.value === '(') {
        ast.hasAggregate = true;
      }
      continue;
    }
    if (t.type !== 'keyword') continue;

    if (t.value === 'ORDER' && next?.type === 'keyword' && next.value === 'BY') {
      ast.hasOrderBy = true;
      i++;
      continue;
    }
    if (t.value === 'GROUP' && next?.type === 'keyword' && next.value === 'BY') {
      ast.hasGroupBy = true;
      i++;
      continue;
    }
    if (t.value === 'LIMIT') ast.hasLimit = true;
    if (t.value === 'WHERE') ast.hasWhere = true;
    if (t.value === 'HAVING') ast.hasHaving = true;

    const joinModifier =
      t.value === 'INNER' ||
      t.value === 'LEFT' ||
      t.value === 'RIGHT' ||
      t.value === 'FULL' ||
      t.value === 'CROSS' ||
      t.value === 'NATURAL';
    const modifierHasJoin =
      joinModifier &&
      (
        next?.value === 'JOIN' ||
        (next?.value === 'OUTER' && sig[i + 2]?.value === 'JOIN')
      );
    if (t.value === 'JOIN' || modifierHasJoin) {
      ast.hasJoin = true;
    }
    if ((t.value === 'LEFT' || t.value === 'RIGHT' || t.value === 'FULL') && modifierHasJoin) {
      ast.hasOuterJoin = true;
    }
    if (AGGREGATES.has(t.value) && next?.type === 'punctuation' && next.value === '(') {
      ast.hasAggregate = true;
    }
    if (t.value === 'FROM' || t.value === 'JOIN') {
      const ref = nextIdentifierValue(sig, i + 1);
      if (ref) tableRefs.push(ref);
    }

    if (t.value === 'EXISTS') {
      ast.hasExists = true;
      // Look back to detect NOT EXISTS. We accept arbitrary whitespace
      // since `sig` already strips it; punctuation like '(' may interpose.
      for (let k = i - 1; k >= 0; k--) {
        const prev = sig[k];
        if (prev.type === 'punctuation' && prev.value === '(') continue;
        if (prev.type === 'keyword' && prev.value === 'NOT') ast.hasNotExists = true;
        break;
      }
    }

    if (t.value === 'UNION') ast.hasSetOp = 'UNION';
    else if (t.value === 'INTERSECT') ast.hasSetOp = 'INTERSECT';
    else if (t.value === 'EXCEPT') ast.hasSetOp = 'EXCEPT';

    // A SELECT inside parentheses (and not the leading token) is a subquery indicator.
    if (t.value === 'SELECT' && i > 0 && parenDepth > 0) {
      ast.hasSubquery = true;
    }
  }

  const seen = new Set();
  for (const ref of tableRefs) {
    const key = normaliseIdentifier(ref).toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      ast.hasSelfJoin = true;
      break;
    }
    seen.add(key);
  }

  return ast;
}

/**
 * @param {Array<{type:string, value:string}>} tokens
 * @param {number} start
 * @returns {string | null}
 */
function nextIdentifierValue(tokens, start) {
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punctuation' && t.value === '(') return null;
    if (t.type === 'identifier') return t.value;
    if (t.type === 'keyword') return null;
  }
  return null;
}

/**
 * @param {string} raw
 */
function normaliseIdentifier(raw) {
  const s = String(raw ?? '');
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '`' && last === '`') || (first === '"' && last === '"')) {
      return s.slice(1, -1).replace(new RegExp(`${escapeRegExp(first)}${escapeRegExp(first)}`, 'g'), first);
    }
  }
  return s;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
