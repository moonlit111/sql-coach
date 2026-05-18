// QuestionGen_Agent node.
//
// Validates: R5.3 (Chinese prompt; refSql ASCII-only OUTSIDE string
// literals — Chinese inside '...' is allowed so questions over Chinese
// seed data can write natural WHERE filters), R7.4 (EXCEPT note in
// prompt), R8.4 (L3 must include one course-emphasis topic), R8.5
// (L4 ≥2 topics), R8.6/R8.7/R8.8 (refSql executable, ≤2 retries),
// R9.1–R9.6, R19.1 / R19.2 / R19.3 (is_ordered ⇔ ORDER BY/排序).
//
// Test-first: tests/orchestrator/question-gen.property.test.js
// (Property 8) drives the post-validator.

import { questionGenPrompt } from '../prompts/index.js';
import { L3_REQUIRED_TOPICS } from '../../data/topics.js';
import { parse } from '../../sql/parser.js';
import { extractJsonObject, vendorExtras } from '../llm-utils.js';

// ── Schema profiling ───────────────────────────────────────────────
// Why this exists: the single biggest cause of "refSql 结果为空" retries
// is the model picking a WHERE / HAVING value that doesn't match any
// real row. Sending raw sample rows helps but isn't enough — the
// LLM still hallucinates strings like 'VIP_GOLD' when only 'gold'
// exists. The profiler emits, per column:
//   • categorical (low cardinality TEXT/VARCHAR/CHAR/BOOLEAN)
//     → the FULL set of distinct values inline, so the model can only
//       pick from real ones
//   • categorical (high cardinality)
//     → the top 8 values + a "+N more" tail, plus distinct count
//   • numeric / decimal
//     → min, max, distinct count → model picks reasonable thresholds
//   • date / datetime
//     → min, max so range filters cover the actual data window
// Research backing this: LlamaIndex NLSQLRetriever, SQLfuse, RSL-SQL
// (2024) all converge on "supply real column values + enumerations".

/** Heuristic: classify a SQL type string into one of four kinds we
 *  profile differently. Keep loose substring matches so MySQL/SQLite
 *  variants (e.g. `INT`, `INTEGER`, `BIGINT`) all map to numeric. */
function classifyType(typeStr) {
  const t = String(typeStr || '').toUpperCase();
  if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|REAL|FLOAT|DOUBLE)/.test(t)) return 'numeric';
  if (/^(DATE|DATETIME|TIMESTAMP|TIME)/.test(t)) return 'datetime';
  if (/^(BOOL|BOOLEAN)/.test(t)) return 'bool';
  // VARCHAR, CHAR, TEXT, anything else → text
  return 'text';
}

/** Truncate a value for inline display in the prompt. Strings get
 *  quoted; long strings get cut with an ellipsis so 1 row of dump
 *  stays scannable. */
function fmtVal(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (s.length > 28) return `'${s.slice(0, 26)}…'`;
  return /[a-zA-Z0-9_.\-+]+/.test(s) && !/[,;:'"\\]/.test(s) ? `'${s}'` : `'${s.replace(/'/g, "''")}'`;
}

const ENUM_THRESHOLD = 15;   // distinct count ≤ this → list ALL values
const TOPK_FALLBACK  = 8;    // distinct count >  this → list top K by frequency

/**
 * Build a per-column profile for every table in the schema. Issues a
 * handful of read-only SELECTs against the sandbox and aggregates the
 * results into a tree the prompt builder can render compactly.
 *
 * Best-effort: any per-column failure is swallowed so a single broken
 * column never sinks the whole question-gen attempt.
 *
 * @param {import('../../types.js').TableSchema[]} schemaSummary
 * @param {{ exec: (sql: string, opts?: any) => Promise<any> }} sandbox
 * @returns {Promise<Record<string, {
 *   rowCount: number,
 *   columns: Record<string, any>
 * }>>}
 */
async function profileSchema(schemaSummary, sandbox) {
  /** @type {Record<string, { rowCount: number, columns: Record<string, any> }>} */
  const out = {};
  for (const t of schemaSummary ?? []) {
    /** @type {Record<string, any>} */
    const cols = {};
    let rowCount = 0;
    try {
      const cnt = await sandbox.exec(`SELECT COUNT(*) FROM "${t.name}"`, { allowDml: false });
      rowCount = Number(cnt?.rows?.[0]?.[0] ?? 0);
    } catch { /* leave as 0 */ }
    if (rowCount === 0) {
      out[t.name] = { rowCount: 0, columns: {} };
      continue;
    }

    for (const c of t.columns ?? []) {
      const kind = classifyType(c.type);
      try {
        if (kind === 'numeric') {
          const r = await sandbox.exec(
            `SELECT MIN("${c.name}"), MAX("${c.name}"), COUNT(DISTINCT "${c.name}") FROM "${t.name}"`,
            { allowDml: false },
          );
          const [min, max, distinct] = r?.rows?.[0] ?? [];
          cols[c.name] = { type: c.type, kind: 'numeric', min, max, distinct: Number(distinct ?? 0) };
        } else if (kind === 'datetime') {
          const r = await sandbox.exec(
            `SELECT MIN("${c.name}"), MAX("${c.name}") FROM "${t.name}"`,
            { allowDml: false },
          );
          const [min, max] = r?.rows?.[0] ?? [];
          cols[c.name] = { type: c.type, kind: 'datetime', min, max };
        } else if (kind === 'bool') {
          const r = await sandbox.exec(
            `SELECT DISTINCT "${c.name}" FROM "${t.name}" ORDER BY "${c.name}"`,
            { allowDml: false },
          );
          cols[c.name] = {
            type: c.type, kind: 'bool',
            distinctValues: (r?.rows ?? []).map((row) => row[0]),
          };
        } else {
          // text — first count distincts, then either fetch all (low card)
          // or top K by frequency (high card).
          const dCnt = await sandbox.exec(
            `SELECT COUNT(DISTINCT "${c.name}") FROM "${t.name}"`,
            { allowDml: false },
          );
          const distinct = Number(dCnt?.rows?.[0]?.[0] ?? 0);
          if (distinct <= ENUM_THRESHOLD) {
            const r = await sandbox.exec(
              `SELECT DISTINCT "${c.name}" FROM "${t.name}" WHERE "${c.name}" IS NOT NULL ORDER BY "${c.name}"`,
              { allowDml: false },
            );
            cols[c.name] = {
              type: c.type, kind: 'enum', distinct,
              distinctValues: (r?.rows ?? []).map((row) => row[0]),
            };
          } else {
            const r = await sandbox.exec(
              `SELECT "${c.name}", COUNT(*) AS cnt FROM "${t.name}" `
              + `WHERE "${c.name}" IS NOT NULL GROUP BY "${c.name}" `
              + `ORDER BY cnt DESC LIMIT ${TOPK_FALLBACK}`,
              { allowDml: false },
            );
            cols[c.name] = {
              type: c.type, kind: 'text', distinct,
              topValues: (r?.rows ?? []).map((row) => row[0]),
            };
          }
        }
      } catch { /* skip this column */ }
    }
    out[t.name] = { rowCount, columns: cols };
  }
  return out;
}

/** Render the column profile as a compact text block for the prompt.
 *  Format chosen to be skimmable at a glance:
 *    customers (15 行)
 *      id        INTEGER   范围 [1, 15] · 15 个不同值
 *      tier      VARCHAR   枚举值: 'VIP', 'gold', 'silver', 'bronze'
 *      country   VARCHAR   枚举值: 'CN', 'US', 'JP'
 *      name      VARCHAR   15 个不同值, 高频前 8: '张三', '李四', ...
 */
function formatProfile(profile) {
  if (!profile || Object.keys(profile).length === 0) return '';
  const lines = ['\n\n列级元信息（可用于挑选 WHERE / HAVING 的实际值）：'];
  for (const [tname, t] of Object.entries(profile)) {
    lines.push(`${tname} (${t.rowCount} 行)`);
    for (const [cname, c] of Object.entries(t.columns ?? {})) {
      const pad = (s) => (s + ' '.repeat(14)).slice(0, 14);
      const head = `  ${pad(cname)}${pad(c.type)}`;
      if (c.kind === 'numeric') {
        lines.push(`${head}范围 [${fmtVal(c.min)}, ${fmtVal(c.max)}] · ${c.distinct} 个不同值`);
      } else if (c.kind === 'datetime') {
        lines.push(`${head}范围 [${fmtVal(c.min)}, ${fmtVal(c.max)}]`);
      } else if (c.kind === 'enum') {
        const vals = (c.distinctValues ?? []).map(fmtVal).join(', ');
        lines.push(`${head}枚举值: ${vals || '(无非空值)'}`);
      } else if (c.kind === 'bool') {
        const vals = (c.distinctValues ?? []).map(fmtVal).join(', ');
        lines.push(`${head}取值: ${vals || '(无非空值)'}`);
      } else {
        const top = (c.topValues ?? []).map(fmtVal).join(', ');
        lines.push(`${head}${c.distinct} 个不同值, 高频前 ${(c.topValues ?? []).length}: ${top}`);
      }
    }
  }
  return lines.join('\n');
}

// Cosmetic punctuation that CJK keyboards / IMEs emit by mistake. Every
// entry is a strict ASCII equivalent — we normalise these whether they
// appear inside or outside a string literal because the model never
// intends fullwidth punctuation as data; it's almost always a typo. The
// smart-quote pair listed first is the load-bearing one — it lets the
// state machine below recognise smart-quoted strings as strings.
const PUNCT_NORMALISE = {
  '‘': "'", '’': "'",   // ‘ ’ → '
  '“': '"', '”': '"',   // “ ” → "
  '，': ',', '；': ';', '：': ':', '．': '.',
  '（': '(', '）': ')',
  '［': '[', '］': ']',
  '｛': '{', '｝': '}',
  '＝': '=', '＞': '>', '＜': '<',
  '！': '!', '？': '?',
  '＊': '*', '％': '%', '＃': '#',
  '＋': '+', '－': '-', '／': '/', '＼': '\\',
  '｜': '|', '＆': '&', '＠': '@', '＄': '$',
  '　': ' ',                  // ideographic space
};

/**
 * Normalise common fullwidth/smart-quote typos into their ASCII
 * equivalents and verify that no non-ASCII codepoint remains OUTSIDE
 * a string literal or a comment. Inside `'...'` (with `''` as escaped
 * quote), `-- line comments`, and `/* block comments *\/` any codepoint
 * is permitted — that's how we let the model write
 * `WHERE name = '张三'` against Chinese seed data.
 *
 * Returns the (possibly rewritten) SQL on success, or a structured
 * rejection reason naming the offending character so the retry loop
 * can feed it back to the model.
 *
 * @param {string} sql
 * @returns {{ ok: true, sql: string } | { ok: false, reason: string }}
 */
export function normaliseAndCheckRefSql(sql) {
  if (typeof sql !== 'string') return { ok: false, reason: 'refSql 不是字符串' };

  // 4-state scanner. Comments shadow string detection: a quote inside a
  // -- line comment or /* block comment */ does NOT open a string. This
  // matches SQL semantics and prevents false "unclosed string" errors
  // when the model leaves quotes inside a trailing comment.
  const NORMAL = 0, IN_STRING = 1, IN_LINE_COMMENT = 2, IN_BLOCK_COMMENT = 3;
  let state = NORMAL;
  let out = '';

  for (let i = 0; i < sql.length; i++) {
    let ch = sql[i];
    // Normalise typo-class punctuation regardless of context. The smart
    // quotes need to map BEFORE state branching so a smart-quoted string
    // is detected as a string at all.
    if (PUNCT_NORMALISE[ch] !== undefined) ch = PUNCT_NORMALISE[ch];
    const code = ch.charCodeAt(0);

    if (state === IN_STRING) {
      if (ch === "'") {
        // Standard SQL: doubled '' inside a string is a literal '.
        const peek = sql[i + 1];
        const peekNorm = PUNCT_NORMALISE[peek] !== undefined ? PUNCT_NORMALISE[peek] : peek;
        if (peekNorm === "'") { out += "''"; i += 1; continue; }
        state = NORMAL;
      }
      // Inside a string literal, accept any codepoint as data.
      out += ch;
      continue;
    }

    if (state === IN_LINE_COMMENT) {
      // Line comment ends at the next \n (the newline itself is normal SQL).
      if (ch === '\n') state = NORMAL;
      out += ch;
      continue;
    }

    if (state === IN_BLOCK_COMMENT) {
      if (ch === '*' && sql[i + 1] === '/') {
        out += '*/'; i += 1; state = NORMAL; continue;
      }
      out += ch;
      continue;
    }

    // state === NORMAL
    // Open a comment first (so quotes inside comments don't open a string).
    if (ch === '-' && sql[i + 1] === '-') {
      out += '--'; i += 1; state = IN_LINE_COMMENT; continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      out += '/*'; i += 1; state = IN_BLOCK_COMMENT; continue;
    }
    if (ch === "'") { state = IN_STRING; out += ch; continue; }

    if (code >= 128) {
      return {
        ok: false,
        reason: `refSql 在字符串字面量外含非 ASCII 字符 "${ch}" (U+${code.toString(16).toUpperCase().padStart(4, '0')})。中文 / 全角标点只允许出现在 '...' 之间。`,
      };
    }
    out += ch;
  }

  if (state === IN_STRING) {
    return { ok: false, reason: 'refSql 字符串字面量未闭合（缺少结尾的单引号）' };
  }
  if (state === IN_BLOCK_COMMENT) {
    return { ok: false, reason: 'refSql 块注释未闭合（缺少 */）' };
  }
  return { ok: true, sql: out };
}

const MAX_ATTEMPTS = 3;

/**
 * Extract referenced table names from a SQL string. Best-effort regex
 * scan — used ONLY for diagnostic feedback when refSql returns 0 rows,
 * not for correctness. Handles `FROM tbl`, `FROM tbl t`, `JOIN tbl ON`,
 * including comma-joined `FROM a, b, c` and quoted identifiers.
 *
 * Skips substrings inside `'...'` string literals so values like
 * `WHERE name = 'from_addr'` don't get mistaken for table refs.
 *
 * @param {string} sql
 * @returns {string[]}
 */
function extractReferencedTables(sql) {
  if (typeof sql !== 'string') return [];
  // Strip string literals so the regex can't trip on the word "FROM"
  // appearing inside data values.
  let stripped = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") { i++; continue; }
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; continue; }
    stripped += ch;
  }
  const out = new Set();
  // FROM table[, table2[, ...]]   — capture comma-separated table list
  const fromRe = /\bFROM\s+([`"]?[\w]+[`"]?(?:\s*,\s*[`"]?[\w]+[`"]?)*)/gi;
  // JOIN table
  const joinRe = /\bJOIN\s+([`"]?[\w]+[`"]?)/gi;
  let m;
  while ((m = fromRe.exec(stripped)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/[`"]/g, '');
      if (name && /^[a-zA-Z_]\w*$/.test(name)) out.add(name);
    }
  }
  while ((m = joinRe.exec(stripped)) !== null) {
    const name = m[1].trim().replace(/[`"]/g, '');
    if (name && /^[a-zA-Z_]\w*$/.test(name)) out.add(name);
  }
  return [...out];
}

/**
 * When refSql returned 0 rows, run a few diagnostic queries against the
 * sandbox so the next retry can give the model concrete numbers to
 * reason about. Caps the work at ~6 quick COUNT(*) probes.
 *
 * @param {string} refSql
 * @param {{ exec: (sql: string, opts?: any) => Promise<any> }} sandbox
 * @param {Array<{name:string}>=} schemaSummary  optional fallback when regex finds nothing
 * @returns {Promise<{
 *   tables: Array<{ name: string, rows: number }>,
 *   hint: string,
 * }>}
 */
async function diagnoseEmptyResult(refSql, sandbox, schemaSummary) {
  let tableNames = extractReferencedTables(refSql);
  if (tableNames.length === 0 && Array.isArray(schemaSummary)) {
    // Fallback: if regex found nothing (parser-defying SQL), probe the
    // first few schema tables instead so the hint isn't empty.
    tableNames = schemaSummary.slice(0, 3).map((t) => t.name);
  }
  /** @type {Array<{ name: string, rows: number }>} */
  const tables = [];
  for (const name of tableNames.slice(0, 6)) {
    try {
      const rs = await sandbox.exec(`SELECT COUNT(*) FROM "${name}"`, { allowDml: false });
      const count = Number(rs?.rows?.[0]?.[0] ?? 0);
      tables.push({ name, rows: Number.isFinite(count) ? count : 0 });
    } catch { /* table may not exist (regex misfire); skip */ }
  }
  // Build a human-readable hint that the next prompt iteration can act
  // on. Spell out the numbers — the model is much more reliable when
  // told "users has 18 rows" than told "you filtered too aggressively".
  const tableSummary = tables.length > 0
    ? tables.map((t) => `${t.name}(${t.rows} 行)`).join('、')
    : '未识别出引用的表';
  let hint = `参考 SQL 在沙箱中执行成功但返回 0 行。`;
  hint += `\n  涉及表：${tableSummary}`;
  if (tables.some((t) => t.rows > 0)) {
    hint += `\n  这意味着 WHERE/HAVING/JOIN 过滤把所有候选行都剔除了。`
          + `\n  请在下一次重试中：`
          + `\n  (1) 优先使用样本数据中明确出现过的字面量；`
          + `\n  (2) 把严格的 INNER JOIN 改成 LEFT JOIN，或放宽 HAVING 阈值；`
          + `\n  (3) 调整 WHERE 谓词使其匹配更多现有数据；`
          + `\n  (4) 必要时改写题面以与放宽后的 SQL 一致。`;
  } else {
    hint += `\n  涉及的表本身就是空的。请改写题目使用其他表，或提示用户重新生成数据集。`;
  }
  return { tables, hint };
}

/**
 * Map every topic to a structural predicate over the parsed AST.
 * Topics without a clean structural test (e.g. `single_table_select`) pass
 * by default — the LLM owns those semantics; we only enforce the topics
 * for which a coarse AST flag is available.
 *
 * @type {Record<string, (ast: import('../../sql/ast.js').SqlAst) => boolean>}
 */
const TOPIC_PREDICATES = {
  group_by_having:        (ast) => ast.hasGroupBy && ast.hasHaving,
  // We don't differentiate correlated from uncorrelated subqueries at the
  // coarse parser level; require a subquery and let the prompt drive the
  // "correlated" semantics (acceptable per design D5).
  correlated_subquery:    (ast) => ast.hasSubquery,
  exists_not_exists:      (ast) => ast.hasExists,
  // Universal-quantifier translation typically uses NOT EXISTS — we accept
  // either EXISTS or a structural NOT EXISTS hit by checking hasExists.
  universal_quantifier:   (ast) => ast.hasExists,
  set_operation_union:    (ast) => ast.hasSetOp === 'UNION',
  set_operation_intersect:(ast) => ast.hasSetOp === 'INTERSECT',
  set_operation_except:   (ast) => ast.hasSetOp === 'EXCEPT' || ast.hasNotExists,
  join_inner:             (ast) => ast.hasJoin,
  join_outer:             (ast) => ast.hasJoin,
  join_self:              (ast) => ast.hasJoin,
  subquery:               (ast) => ast.hasSubquery,
  // The remaining topics have no structural test.
  single_table_select:    () => true,
  where_filter:           () => true,
  order_by_limit:         (ast) => ast.hasOrderBy,
  aggregate_function:     () => true,
  set_vs_join_compare:    () => true,
};

/**
 * Validate a candidate question (LLM JSON response shape, with `difficulty`
 * already attached by the node). Returns `{ ok: true, ast }` on success.
 *
 * @param {any} q
 * @returns {{ ok: true, ast: import('../../sql/ast.js').SqlAst } | { ok: false, reason: string }}
 */
export function validateQuestion(q) {
  if (!q || typeof q !== 'object') return { ok: false, reason: '空响应' };
  if (typeof q.prompt !== 'string' || typeof q.refSql !== 'string') {
    return { ok: false, reason: '缺少 prompt 或 refSql' };
  }
  if (!Array.isArray(q.topics) || q.topics.length === 0) {
    return { ok: false, reason: '缺少 topics' };
  }

  // R5.3 — Chinese in prompt.
  if (!/[\u4e00-\u9fff]/.test(q.prompt)) {
    return { ok: false, reason: '题面缺少中文' };
  }

  // R5.3 - refSql ASCII outside string literals; inside '...' any
  // codepoint is fine (so questions can write WHERE name = 'Chinese
  // value' against Chinese seed data). We also normalise common
  // fullwidth/smart-quote typos in place so the model isn't punished
  // for cosmetic punctuation.
  const refCheck = normaliseAndCheckRefSql(q.refSql);
  if (!refCheck.ok) return { ok: false, reason: refCheck.reason };
  q.refSql = refCheck.sql;
  if (typeof q.refSqlAlt === 'string' && q.refSqlAlt.length > 0) {
    const altCheck = normaliseAndCheckRefSql(q.refSqlAlt);
    if (!altCheck.ok) return { ok: false, reason: 'refSqlAlt: ' + altCheck.reason };
    q.refSqlAlt = altCheck.sql;
  }

  // R8.4 / R8.5 — difficulty rules.
  if (q.difficulty === 'L3') {
    const ok = q.topics.some((t) => L3_REQUIRED_TOPICS.includes(t));
    if (!ok) {
      return { ok: false, reason: `L3 必须包含 ${L3_REQUIRED_TOPICS.join('/')} 之一` };
    }
  }
  if (q.difficulty === 'L4' && q.topics.length < 2) {
    return { ok: false, reason: 'L4 必须组合至少 2 个知识点' };
  }

  // R7.4 — EXCEPT prompt note.
  if (q.topics.includes('set_operation_except')) {
    if (!q.prompt.includes('MySQL')) {
      return { ok: false, reason: 'EXCEPT 题面必须提到 MySQL' };
    }
    if (!(q.prompt.includes('NOT IN') || q.prompt.includes('NOT EXISTS'))) {
      return { ok: false, reason: 'EXCEPT 题面必须提到 NOT IN 或 NOT EXISTS 等价写法' };
    }
  }

  // R19.1 / R19.2 / R19.3 — is_ordered ⇔ parse(refSql).hasOrderBy ∨
  // promptHasOrderHint.
  //
  // The original regex (`/按.*?排序/`) only matched the literal phrase
  // "按 X 排序". In practice the LLM frequently expresses ordering with
  // synonyms like "按 X 升序排列", "按 X 降序展示", "依 X 升序", and
  // even bare "升序"/"降序"/"从高到低". When the prompt used a synonym
  // and the model honestly set `is_ordered: true` (matching its own
  // refSql's ORDER BY) the validator would reject as "不一致" — leading
  // to the user-visible failure loop. Broaden the detection to cover
  // the common synonyms while still requiring the keyword to appear in
  // an ordering context (preceded by 按/依/以/从, or attached to the
  // 顺序/升序/降序/从…到… patterns).
  const ast = parse(q.refSql);
  if (ast.error) {
    return { ok: false, reason: `参考 SQL 解析失败：${ast.error}` };
  }
  const promptOrders =
       /按[^，。；\n]{0,40}(排序|排列|排名|排行|展示|显示|输出|返回|列出)/.test(q.prompt)
    || /(依|以|按)[^，。；\n]{0,40}(升序|降序|顺序)/.test(q.prompt)
    || /(升序|降序)(排序|排列|输出|展示|返回)/.test(q.prompt)
    || /从(高到低|低到高|大到小|小到大|新到旧|旧到新)/.test(q.prompt);
  const computedOrdered = ast.hasOrderBy || promptOrders;
  if (Boolean(q.is_ordered) !== Boolean(computedOrdered)) {
    // Spell out *which* side disagrees so the retry prompt can give
    // the model concrete state to fix instead of a blunt "不一致".
    return {
      ok: false,
      reason:
        `is_ordered 与参考 SQL/题面排序不一致：`
        + `is_ordered=${Boolean(q.is_ordered)}, refSql.hasOrderBy=${Boolean(ast.hasOrderBy)}, `
        + `题面含排序提示=${Boolean(promptOrders)}。`
        + `请保证三件事一致：(a) 若 refSql 含 ORDER BY，则题面必须写"按 X 排序"，且 is_ordered=true；`
        + `(b) 若题面要求排序，则 refSql 必须含 ORDER BY，且 is_ordered=true；`
        + `(c) 否则三者均为 false / 不出现。`,
    };
  }

  // Topic predicates — the AST must support every claimed topic.
  for (const t of q.topics) {
    const pred = TOPIC_PREDICATES[t];
    if (pred && !pred(ast)) {
      return { ok: false, reason: `参考 SQL 不满足知识点 ${t} 的结构特征` };
    }
  }

  // R9.6 — set_vs_join_compare requires refSqlAlt.
  if (q.topics.includes('set_vs_join_compare') && !q.refSqlAlt) {
    return { ok: false, reason: 'set_vs_join_compare 必须提供 refSqlAlt' };
  }

  return { ok: true, ast };
}

/**
 * Build a QuestionGen node bound to an LLM client and a sandbox instance.
 *
 * @param {{
 *   llmClient: { chat: (messages: any[], opts?: any) => Promise<{ content: string }> },
 *   sandbox:   { exec: (sql: string, opts?: any) => Promise<any> },
 *   onProgress?: (event: { phase: string, attempt: number, status: 'running'|'ok'|'fail', detail?: string }) => void,
 * }} deps
 */
export function createQuestionGenNode({ llmClient, sandbox, onProgress }) {
  const emit = (phase, attempt, status, detail) => {
    try { onProgress?.({ phase, attempt, status, detail }); } catch { /* never break the agent */ }
  };

  /**
   * @param {import('../../types.js').AgentState & {
   *   requestedDifficulty?: import('../../types.js').DifficultyLevel,
   *   requestedTopics?:     import('../../types.js').QuestionTopic[],
   *   schemaRef?:           string,
   * }} state
   * @returns {Promise<Partial<import('../../types.js').AgentState>>}
   */
  return async function questionGenNode(state) {
    if (!state.schemaSummary) {
      return { failedAgent: 'QuestionGen', error: '缺少 schema' };
    }

    // Pull a few sample rows per table so the prompt has concrete row
    // associations (helpful for JOINs); the column profile below carries
    // the broader value distribution that drives WHERE / HAVING choices.
    // We use ORDER BY rowid so different schema sizes give a stable
    // top-of-file slice (instead of whatever SQLite happens to dispatch).
    const sampleRows = {};
    for (const t of state.schemaSummary) {
      try {
        const rs = await sandbox.exec(
          `SELECT * FROM "${t.name}" ORDER BY rowid LIMIT 6`,
          { allowDml: false },
        );
        if (rs && !rs.kind && rs.rows?.length) {
          sampleRows[t.name] = rs.rows.map((row) => {
            const obj = {};
            (rs.columns ?? []).forEach((c, i) => { obj[c] = row[i]; });
            return obj;
          });
        }
      } catch { /* sample rows are best-effort; skip silently */ }
    }

    // Column-level profile — the heavy lifter for matching WHERE values
    // to real data. Computed once per question-gen call (re-used across
    // all 3 retry attempts) since the underlying schema doesn't change.
    let columnProfile = {};
    let columnProfileText = '';
    try {
      columnProfile = await profileSchema(state.schemaSummary, sandbox);
      columnProfileText = formatProfile(columnProfile);
    } catch { /* profile is best-effort */ }

    let lastError;
    /** Tracks how many attempts ended specifically with "0 rows from refSql".
     *  When the loop exhausts and this is ≥1 we surface a structured
     *  errorKind so the UI can render targeted "fix" actions. */
    let emptyAttempts = 0;
    /** Latest diagnostic gathered from a 0-row attempt. Stashed so the
     *  terminal failure return can include concrete table-row numbers
     *  for the UI's hint dialog. */
    let lastEmptyDiag = null;
    const extras = vendorExtras(state?.llm?.modelName);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        emit('llm', attempt, 'running', `第 ${attempt}/${MAX_ATTEMPTS} 次调用模型`);
        const messages = questionGenPrompt.buildPrompt({
          schemaSummary: state.schemaSummary,
          difficulty:    state.requestedDifficulty,
          topics:        state.requestedTopics ?? [],
          retryError:    lastError,
          sampleRows,
          columnProfileText,
          customPrompt:  state.customPrompt,
        });
        const { content } = await llmClient.chat(messages, {
          responseFormat: 'json_object',
          maxTokens: 2048,
          ...(extras ? { extraBody: extras } : {}),
        });
        emit('llm', attempt, 'ok', `模型返回 ${content.length} 字符`);

        emit('parse', attempt, 'running');
        const jsonStr = extractJsonObject(content);
        if (jsonStr === null) {
          lastError = `响应中找不到 JSON 对象（前 200 字符）：${String(content).slice(0, 200)}`;
          emit('parse', attempt, 'fail', lastError);
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (e) {
          lastError = `JSON 解析失败：${String(e?.message ?? e)}`;
          emit('parse', attempt, 'fail', lastError);
          continue;
        }
        emit('parse', attempt, 'ok');

        // The LLM frequently forgets to echo the difficulty back; attach it.
        parsed.difficulty = state.requestedDifficulty;

        // Same problem with topics — the LLM curates its own topic set that
        // "fits" the SQL it just wrote, often dropping IDs the user
        // explicitly picked (e.g. user picks ["join_inner","where_filter"]
        // but the LLM returns only ["join_inner"]). Merge the user's
        // requested topics into parsed.topics so the AST-predicate check
        // inside validateQuestion verifies that the generated SQL actually
        // supports each requested topic structurally. If a requested topic
        // has no structural support (e.g. user asked for `exists_not_exists`
        // but the SQL has no EXISTS), validateQuestion fails with that
        // topic in the reason and the retry loop feeds it back to the LLM.
        //
        // This also keeps L3/L4 difficulty rules working: the LLM is still
        // free to ADD topics on top of the user's selection (e.g. add a
        // course-emphasis topic for L3, or pad to ≥2 topics for L4), and
        // the merge preserves those additions.
        const requested = state.requestedTopics ?? [];
        if (requested.length > 0) {
          const existing = Array.isArray(parsed.topics) ? parsed.topics : [];
          parsed.topics = [...new Set([...existing, ...requested])];
        }

        emit('validate', attempt, 'running', '检查难度/排序/知识点');
        const v = validateQuestion(parsed);
        if (!v.ok) {
          lastError = v.reason;
          emit('validate', attempt, 'fail', lastError);
          continue;
        }
        emit('validate', attempt, 'ok');

        // R8.6 — execute refSql against the sandbox to confirm it parses
        // and produces a non-empty result (unless the prompt explicitly
        // expects an empty set, which we don't currently special-case).
        emit('sandbox', attempt, 'running', '在沙箱中验证参考 SQL');
        const rs = await sandbox.exec(parsed.refSql, { allowDml: false });
        if (!rs || rs.kind) {
          lastError = `refSql 执行失败：${rs?.message ?? 'unknown'}`;
          emit('sandbox', attempt, 'fail', lastError);
          continue;
        }
        if ((rs.rows?.length ?? 0) === 0) {
          // R8.6 — empty result is a hard reject, but we don't just hand
          // the model a blunt "结果为空" string. Run a quick diagnostic
          // (per-table COUNT) so the next retry can pick a value that
          // actually exists or relax the predicate to match real data.
          emptyAttempts += 1;
          const diag = await diagnoseEmptyResult(parsed.refSql, sandbox, state.schemaSummary);
          lastEmptyDiag = diag;
          lastError = diag.hint;
          emit('sandbox', attempt, 'fail', '参考 SQL 结果为空（已附诊断信息给下次重试）');
          continue;
        }

        if (parsed.refSqlAlt) {
          const altRs = await sandbox.exec(parsed.refSqlAlt, { allowDml: false });
          if (!altRs || altRs.kind) {
            lastError = `refSqlAlt 执行失败：${altRs?.message ?? 'unknown'}`;
            emit('sandbox', attempt, 'fail', lastError);
            continue;
          }
        }
        emit('sandbox', attempt, 'ok', `参考 SQL 返回 ${rs.rows.length} 行`);

        const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        /** @type {import('../../types.js').Question} */
        const question = {
          id,
          createdAt:      Date.now(),
          difficulty:     parsed.difficulty,
          topics:         parsed.topics,
          prompt:         parsed.prompt,
          refSql:         parsed.refSql,
          refSqlAlt:      parsed.refSqlAlt,
          expectedResult: rs,
          isOrdered:      Boolean(parsed.is_ordered),
          schemaRef:      state.schemaRef ?? 'current',
        };
        return { question };
      } catch (e) {
        lastError = String(e?.message ?? e?.kind ?? e);
        emit('llm', attempt, 'fail', lastError);
      }
    }

    // All MAX_ATTEMPTS exhausted. If the dominant failure was empty
    // results, return a structured errorKind so the UI can render a
    // tailored "fix" dialog with action buttons (switch DB, reduce
    // topics, regenerate dataset). Otherwise return a plain error.
    const allEmpty = emptyAttempts >= 2 || (emptyAttempts >= 1 && MAX_ATTEMPTS === 1);
    if (allEmpty) {
      return {
        failedAgent: 'QuestionGen',
        error: lastError ?? '参考 SQL 反复返回空结果',
        errorKind: 'empty_results_exhausted',
        errorContext: {
          emptyAttempts,
          totalAttempts: MAX_ATTEMPTS,
          tables: lastEmptyDiag?.tables ?? [],
          requestedTopics: state.requestedTopics ?? [],
          requestedDifficulty: state.requestedDifficulty,
        },
      };
    }
    return { failedAgent: 'QuestionGen', error: lastError ?? 'unknown QuestionGen failure' };
  };
}
