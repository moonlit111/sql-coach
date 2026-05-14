// SchemaGen_Agent node.
//
// Validates: R6.2 (≥3 tables, ≥1 FK, ≥5 rows per table), R6.3 (theme),
// R6.4 (DDL must execute in sandbox), R6.5 (≤2 retries on failure, fail
// hard on the 3rd), R6.6 (custom-theme description), R7.1 / R7.2
// (MySQL-compatible subset).
//
// Test-first: see tests/orchestrator/graph.property.test.js for retry
// counting (Property 9).

import { schemaGenPrompt } from '../prompts/index.js';

const MAX_ATTEMPTS = 3;

/**
 * Token-style strings that must NEVER appear in generated DDL/seed SQL
 * (R7.2). Match is case-insensitive and substring-based — the LLM is
 * instructed to avoid these in the prompt, this is a defence in depth.
 */
const FORBIDDEN_TOKENS = ['AUTOINCREMENT', 'WITHOUT ROWID', 'PRAGMA'];

/**
 * Build a SchemaGen node bound to an LLM client and a sandbox instance.
 * The returned function is the LangGraph-style node:
 *   `(state) => Partial<AgentState>`.
 *
 * @param {{
 *   llmClient: { chat: (messages: any[], opts?: any) => Promise<{ content: string, raw?: any }> },
 *   sandbox:   {
 *     loadSchema: (ddl: string, seedSql: string) => Promise<{ ok: boolean, error?: string }>,
 *     describeSchema: () => import('../../types.js').TableSchema[],
 *     exec: (sql: string, opts?: any) => Promise<any>,
 *   },
 * }} deps
 */
export function createSchemaGenNode({ llmClient, sandbox }) {
  /**
   * @param {import('../../types.js').AgentState} state
   * @returns {Promise<Partial<import('../../types.js').AgentState>>}
   */
  return async function schemaGenNode(state) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const messages = schemaGenPrompt.buildPrompt({
          theme: state.theme,
          themeDescription: state.themeDescription,
          retryError: lastError,
        });
        const { content } = await llmClient.chat(messages, { responseFormat: 'json_object' });

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          lastError = `JSON 解析失败：${String(e?.message ?? e)}`;
          continue;
        }
        const ddl     = parsed?.ddl;
        const seedSql = parsed?.seedSql;
        if (typeof ddl !== 'string' || typeof seedSql !== 'string') {
          lastError = '响应缺少 ddl 或 seedSql 字段';
          continue;
        }

        // R7.2 — substring scan against forbidden tokens (defence in depth;
        // SQLite would silently accept e.g. AUTOINCREMENT but MySQL alignment
        // (R7.1) demands we reject it).
        const upper = (ddl + '\n' + seedSql).toUpperCase();
        const found = FORBIDDEN_TOKENS.find((t) => upper.includes(t));
        if (found) {
          lastError = `生成的 SQL 含禁止关键字：${found}`;
          continue;
        }

        // R6.4 — actually execute the DDL + seed in the sandbox.
        const r = await sandbox.loadSchema(ddl, seedSql);
        if (!r.ok) {
          lastError = `沙箱执行失败：${r.error}`;
          continue;
        }

        // R6.2 — post-conditions: ≥3 tables and at least one FK.
        const tables = sandbox.describeSchema();
        if (!Array.isArray(tables) || tables.length < 3) {
          lastError = `生成的表数量不足 3：${tables?.length ?? 0}`;
          continue;
        }
        const hasFk = tables.some((t) => (t.foreignKeys?.length ?? 0) > 0);
        if (!hasFk) {
          lastError = '至少需要一对外键关联';
          continue;
        }

        // R6.2 — ≥5 rows per table.
        let rowsOk = true;
        for (const t of tables) {
          const rs = await sandbox.exec(`SELECT COUNT(*) FROM "${t.name}"`, { allowDml: false });
          if (!rs || rs.kind || ((rs.rows?.[0]?.[0] ?? 0) < 5)) {
            rowsOk = false;
            lastError = `表 ${t.name} 行数不足 5`;
            break;
          }
        }
        if (!rowsOk) continue;

        return {
          ddl,
          seedSql,
          schemaSummary: tables,
        };
      } catch (e) {
        // The LLM client throws ClassifiedLlmError shapes; we treat them
        // the same as parse/post-validation failures and let retry happen.
        lastError = String(e?.message ?? e?.kind ?? e);
      }
    }

    return { failedAgent: 'SchemaGen', error: lastError ?? 'unknown SchemaGen failure' };
  };
}
