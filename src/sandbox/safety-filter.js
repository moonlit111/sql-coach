// Safety filter for user-submitted SQL.
// Implements Property 6 from design.md:
//   safetyFilter(s, allowDml) returns ok=false IFF
//   (a) the token stream (with strings/comments stripped) contains
//       DROP / ALTER / TRUNCATE / ATTACH / DETACH / PRAGMA, or
//   (b) allowDml=false AND parse(s).kind ∈ {INSERT, UPDATE, DELETE, REPLACE}.

import { tokenize, stripNoise } from '../sql/tokenizer.js';
import { parse } from '../sql/parser.js';

const FORBIDDEN = new Set(['DROP', 'ALTER', 'TRUNCATE', 'ATTACH', 'DETACH', 'PRAGMA']);
const DML_KIND = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

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
    // R18.5 says parser/tokenizer failure should not automatically reject
    // harmless syntax. It must still reject obvious dangerous statements that
    // SQLite accepts but our small tokenizer may not fully support, such as
    // UPDATE [table] ... or DROP TABLE "table".
    return fallbackSafetyScan(sql, { allowDml });
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
      reason: '当前题目不允许数据修改 (INSERT/UPDATE/DELETE/REPLACE)',
    };
  }

  return { ok: true };
}

/**
 * Conservative fallback for SQL outside the tokenizer subset. It strips
 * comments, string literals, and quoted identifiers before scanning for SQL
 * keywords, so literals like 'DROP TABLE' remain harmless while executable
 * DROP/UPDATE/DELETE tokens are still caught.
 *
 * @param {string} sql
 * @param {{ allowDml: boolean }} opts
 * @returns {{ ok: boolean, reason?: string, parserFailed: true }}
 */
function fallbackSafetyScan(sql, { allowDml }) {
  const stripped = stripSqlNoiseAndQuotedIdentifiers(sql);
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(stripped)) {
      return { ok: false, reason: `禁止使用关键字：${kw}`, parserFailed: true };
    }
  }

  if (!allowDml) {
    const lead = /^\s*([A-Z_][A-Z0-9_]*)\b/i.exec(stripped)?.[1]?.toUpperCase();
    if (lead && DML_KIND.has(lead)) {
      return {
        ok: false,
        reason: '当前题目不允许数据修改 (INSERT/UPDATE/DELETE/REPLACE)',
        parserFailed: true,
      };
    }
  }

  return { ok: true, parserFailed: true };
}

/**
 * Replace non-code spans with spaces while preserving statement keywords.
 * Handles SQL single-quoted strings, line/block comments, and the common
 * quoted identifier forms: "name", `name`, [name].
 *
 * @param {string} sql
 * @returns {string}
 */
function stripSqlNoiseAndQuotedIdentifiers(sql) {
  const s = String(sql ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];

    if (ch === '-' && next === '-') {
      out += '  ';
      i += 2;
      while (i < s.length && s[i] !== '\n') { out += ' '; i++; }
      if (i < s.length) out += s[i];
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < s.length) {
        if (s[i] === '*' && s[i + 1] === '/') { out += '  '; i += 1; break; }
        out += s[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    if (ch === "'") {
      out += ' ';
      i++;
      while (i < s.length) {
        out += s[i] === '\n' ? '\n' : ' ';
        if (s[i] === "'") {
          if (s[i + 1] === "'") { i += 2; out += ' '; continue; }
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '"' || ch === '`' || ch === '[') {
      const end = ch === '[' ? ']' : ch;
      out += ' ';
      i++;
      while (i < s.length) {
        out += s[i] === '\n' ? '\n' : ' ';
        if (s[i] === end) {
          if (end !== ']' && s[i + 1] === end) { i += 2; out += ' '; continue; }
          break;
        }
        i++;
      }
      continue;
    }

    out += ch;
  }
  return out;
}
