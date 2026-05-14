// QuestionGen_Agent node.
//
// Validates: R5.3 (Chinese prompt + English/ASCII refSql), R7.4 (EXCEPT
// note in prompt), R8.4 (L3 must include one course-emphasis topic),
// R8.5 (L4 ≥2 topics), R8.6/R8.7/R8.8 (refSql executable, ≤2 retries),
// R9.1–R9.6, R19.1 / R19.2 / R19.3 (is_ordered ⇔ ORDER BY/排序).
//
// Test-first: tests/orchestrator/question-gen.property.test.js
// (Property 8) drives the post-validator.

import { questionGenPrompt } from '../prompts/index.js';
import { L3_REQUIRED_TOPICS } from '../../data/topics.js';
import { parse } from '../../sql/parser.js';

const MAX_ATTEMPTS = 3;

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
  set_operation_except:   (ast) => ast.hasSetOp === 'EXCEPT',
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

  // R5.3 — refSql ASCII only. We scan codepoints rather than using a regex
  // so wide characters anywhere in the string are rejected.
  for (let i = 0; i < q.refSql.length; i++) {
    if (q.refSql.charCodeAt(i) >= 128) {
      return { ok: false, reason: 'refSql 含非 ASCII 字符' };
    }
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
  const ast = parse(q.refSql);
  if (ast.error) {
    return { ok: false, reason: `参考 SQL 解析失败：${ast.error}` };
  }
  const promptOrders   = /按.*?排序/.test(q.prompt);
  const computedOrdered = ast.hasOrderBy || promptOrders;
  if (Boolean(q.is_ordered) !== Boolean(computedOrdered)) {
    return { ok: false, reason: 'is_ordered 与参考 SQL/题面排序不一致' };
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
 * }} deps
 */
export function createQuestionGenNode({ llmClient, sandbox }) {
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

    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const messages = questionGenPrompt.buildPrompt({
          schemaSummary: state.schemaSummary,
          difficulty:    state.requestedDifficulty,
          topics:        state.requestedTopics ?? [],
          retryError:    lastError,
        });
        const { content } = await llmClient.chat(messages, { responseFormat: 'json_object' });

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          lastError = `JSON 解析失败：${String(e?.message ?? e)}`;
          continue;
        }

        // The LLM frequently forgets to echo the difficulty back; attach it.
        parsed.difficulty = state.requestedDifficulty;

        const v = validateQuestion(parsed);
        if (!v.ok) {
          lastError = v.reason;
          continue;
        }

        // R8.6 — execute refSql against the sandbox to confirm it parses
        // and produces a non-empty result (unless the prompt explicitly
        // expects an empty set, which we don't currently special-case).
        const rs = await sandbox.exec(parsed.refSql, { allowDml: false });
        if (!rs || rs.kind) {
          lastError = `refSql 执行失败：${rs?.message ?? 'unknown'}`;
          continue;
        }
        if ((rs.rows?.length ?? 0) === 0) {
          lastError = '参考 SQL 结果为空';
          continue;
        }

        if (parsed.refSqlAlt) {
          const altRs = await sandbox.exec(parsed.refSqlAlt, { allowDml: false });
          if (!altRs || altRs.kind) {
            lastError = `refSqlAlt 执行失败：${altRs?.message ?? 'unknown'}`;
            continue;
          }
        }

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
      }
    }

    return { failedAgent: 'QuestionGen', error: lastError ?? 'unknown QuestionGen failure' };
  };
}
