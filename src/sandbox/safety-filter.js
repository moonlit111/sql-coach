// Safety filter for user-submitted SQL.
// Implements Property 6 from design.md:
//   safetyFilter(s, allowDml) returns ok=false IFF
//   (a) the token stream (with strings/comments stripped) contains
//       DROP / ALTER / TRUNCATE / ATTACH / DETACH / PRAGMA, or
//   (b) allowDml=false AND parse(s).kind ∈ {INSERT, UPDATE, DELETE}.

import { tokenize, stripNoise } from '../sql/tokenizer.js';
import { parse } from '../sql/parser.js';

const FORBIDDEN = new Set(['DROP', 'ALTER', 'TRUNCATE', 'ATTACH', 'DETACH', 'PRAGMA']);
const DML_KIND = new Set(['INSERT', 'UPDATE', 'DELETE']);

/**
 * @param {string} sql
 * @param {{ allowDml?: boolean }} [opts]
 * @returns {{ ok: boolean, reason?: string, parserFailed?: boolean }}
 */
export function safetyFilter(sql, { allowDml = false } = {}) {
  // First, scan tokens directly so that string-literal occurrences of forbidden
  // keywords are never flagged (the tokenizer surfaces them as 'string' tokens).
  let tokens = [];
  try {
    tokens = stripNoise(tokenize(sql));
  } catch {
    // On tokenizer failure, fall back to an empty stream — see R18.5: parser
    // failure does not auto-reject, but we have no token evidence of forbidden
    // keywords either, so we accept.
    return { ok: true, parserFailed: true };
  }

  for (const t of tokens) {
    if (t.type === 'keyword' && FORBIDDEN.has(t.value)) {
      return { ok: false, reason: `禁止使用关键字：${t.value}` };
    }
  }

  // Parse to determine statement kind for the DML check.
  const ast = parse(sql);
  if (ast.error) {
    // R18.5 — let the sandbox try to execute; we already proved no forbidden
    // tokens exist.
    return { ok: true, parserFailed: true };
  }

  if (ast.kind === 'DDL') {
    // Defensive: should already have been caught by the forbidden-token scan,
    // but keep the explicit guard.
    return { ok: false, reason: '禁止 DDL 操作' };
  }

  if (!allowDml && DML_KIND.has(ast.kind)) {
    return {
      ok: false,
      reason: '当前题目不允许数据修改 (INSERT/UPDATE/DELETE)',
    };
  }

  return { ok: true };
}
