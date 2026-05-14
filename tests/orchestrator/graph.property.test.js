// Feature: sql-coach, Property 9: Agent retry count and failure propagation
// Validates: Requirements R6.4, R6.5, R8.7, R8.8, R17.4
//
// Property 9 has three obligations:
//
//   (a) For node n ∈ {SchemaGen, QuestionGen} and k ∈ {1, 2, 3} —
//       a mocked LLM that returns invalid responses for the first k-1
//       calls and a valid one on call k → the node succeeds and the LLM
//       was called EXACTLY k times.
//
//   (b) When the LLM returns invalid responses on all 3 attempts —
//       state.failedAgent === n, state.error is a readable string,
//       LLM call count is exactly 3.
//
//   (c) Any node throwing → orchestrator aborts the flow and tags
//       state.failedAgent (R17.4).
//
// We use a fake `sandbox` — there is no need to spin up sql.js for this
// test. The fake's behaviour is keyed off the SQL string the node passes.

import { describe, it, expect } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { createGraph } from '../../src/orchestrator/graph.js';
import { createInitialState, mergePartial } from '../../src/orchestrator/state.js';

// ---------------------------------------------------------------------------
// Test fixtures: a fake sandbox, a counting LLM client, a known-good schema
// summary so QuestionGen does not have to call SchemaGen first.
// ---------------------------------------------------------------------------

/** @returns {{exec: (sql: string) => Promise<any>, loadSchema: () => Promise<any>, describeSchema: () => any[]}} */
function fakeSandbox({ schema, refResult, dynamic } = {}) {
  const tables = schema ?? [
    { name: 'users',     columns: [{ name: 'id', type: 'INT', nullable: false }],
      primaryKey: ['id'], foreignKeys: [] },
    { name: 'orders',    columns: [{ name: 'id', type: 'INT', nullable: false }],
      primaryKey: ['id'], foreignKeys: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }] },
    { name: 'products',  columns: [{ name: 'id', type: 'INT', nullable: false }],
      primaryKey: ['id'], foreignKeys: [] },
  ];
  return {
    exec: async (sql) => {
      if (typeof dynamic === 'function') {
        const r = dynamic(sql);
        if (r !== undefined) return r;
      }
      // COUNT(*) queries used by SchemaGen post-validator.
      if (/^\s*SELECT\s+COUNT\(\*\)/i.test(sql)) {
        return { columns: ['c'], rows: [[5]] };
      }
      return refResult ?? { columns: ['x'], rows: [[1], [2]] };
    },
    loadSchema: async () => ({ ok: true }),
    describeSchema: () => tables,
  };
}

function countingClient(responses) {
  let i = 0;
  const calls = [];
  return {
    get callCount() { return i; },
    calls,
    chat: async (messages) => {
      calls.push(messages);
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      if (typeof r === 'function') return { content: r(i - 1) };
      return { content: r };
    },
  };
}

function validSchemaJson() {
  return JSON.stringify({
    ddl: 'CREATE TABLE users (id INT PRIMARY KEY); ' +
         'CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, ' +
         '  FOREIGN KEY (user_id) REFERENCES users(id)); ' +
         'CREATE TABLE products (id INT PRIMARY KEY)',
    seedSql: 'INSERT INTO users VALUES (1)',
  });
}

function validQuestionJson({ difficulty, topics, prompt, refSql, isOrdered, refSqlAlt } = {}) {
  return JSON.stringify({
    prompt: prompt ?? '查询所有 users 的 id',
    refSql: refSql ?? 'SELECT id FROM users',
    refSqlAlt,
    topics: topics ?? ['single_table_select'],
    difficulty,
    is_ordered: Boolean(isOrdered),
  });
}

// ---------------------------------------------------------------------------
// Property 9.a / 9.b — SchemaGen retry counting
// ---------------------------------------------------------------------------

describe('Property 9 — SchemaGen retry counting and failure propagation', () => {
  test.prop({ k: fc.integer({ min: 1, max: 3 }) }, { numRuns: 6 })(
    'first valid response on call k ⇒ node succeeds in exactly k LLM calls',
    async ({ k }) => {
      // First k-1 responses are unparseable; call k is a valid schema JSON.
      const responses = [];
      for (let i = 0; i < k - 1; i++) responses.push('not json');
      responses.push(validSchemaJson());

      const llm = countingClient(responses);
      const sandbox = fakeSandbox();
      const graph = createGraph({ llmClient: llm, sandbox });

      const initial = createInitialState({ theme: 'ecommerce' });
      const next = await graph.runNode('schemaGen', initial);

      expect(next.failedAgent).toBeUndefined();
      expect(next.ddl).toBeTypeOf('string');
      expect(next.schemaSummary).toBeDefined();
      expect(llm.callCount).toBe(k);
    },
  );

  it('three invalid responses ⇒ failedAgent="SchemaGen", call count is 3', async () => {
    const llm = countingClient(['nope', 'still nope', 'never']);
    const sandbox = fakeSandbox();
    const graph = createGraph({ llmClient: llm, sandbox });

    const next = await graph.runNode('schemaGen', createInitialState({ theme: 'ecommerce' }));
    expect(next.failedAgent).toBe('SchemaGen');
    expect(typeof next.error).toBe('string');
    expect(next.error.length).toBeGreaterThan(0);
    expect(llm.callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Property 9.a / 9.b — QuestionGen retry counting
// ---------------------------------------------------------------------------

describe('Property 9 — QuestionGen retry counting and failure propagation', () => {
  /** Build a base state already past SchemaGen. */
  function questionGenState() {
    const schemaSummary = [
      { name: 'users', columns: [{ name: 'id', type: 'INT', nullable: false }],
        primaryKey: ['id'], foreignKeys: [] },
    ];
    return mergePartial(createInitialState({ theme: 'ecommerce' }), {
      schemaSummary,
      requestedDifficulty: 'L1',
      requestedTopics: ['single_table_select'],
    });
  }

  test.prop({ k: fc.integer({ min: 1, max: 3 }) }, { numRuns: 6 })(
    'first valid response on call k ⇒ node succeeds in exactly k LLM calls',
    async ({ k }) => {
      const responses = [];
      for (let i = 0; i < k - 1; i++) responses.push('garbage');
      responses.push(validQuestionJson({ difficulty: 'L1' }));

      const llm = countingClient(responses);
      const sandbox = fakeSandbox();
      const graph = createGraph({ llmClient: llm, sandbox });

      const next = await graph.runNode('questionGen', questionGenState());

      expect(next.failedAgent).toBeUndefined();
      expect(next.question).toBeDefined();
      expect(next.question.difficulty).toBe('L1');
      expect(llm.callCount).toBe(k);
    },
  );

  it('three invalid responses ⇒ failedAgent="QuestionGen", call count is 3', async () => {
    const llm = countingClient(['nope', 'still nope', 'never']);
    const sandbox = fakeSandbox();
    const graph = createGraph({ llmClient: llm, sandbox });

    const next = await graph.runNode('questionGen', questionGenState());
    expect(next.failedAgent).toBe('QuestionGen');
    expect(typeof next.error).toBe('string');
    expect(next.error.length).toBeGreaterThan(0);
    expect(llm.callCount).toBe(3);
  });

  it('valid JSON but post-validator rejects ⇒ counts as a failed attempt', async () => {
    // Three structurally-valid responses that all fail Property 8's L3 rule
    // (no required L3 topic in topics list).
    const bad = JSON.stringify({
      prompt: '查询所有用户',
      refSql: 'SELECT id FROM users',
      topics: ['single_table_select'],
      difficulty: 'L3',
      is_ordered: false,
    });
    const llm = countingClient([bad, bad, bad]);
    const sandbox = fakeSandbox();
    const graph = createGraph({ llmClient: llm, sandbox });

    const state = mergePartial(questionGenState(), { requestedDifficulty: 'L3' });
    const next = await graph.runNode('questionGen', state);
    expect(next.failedAgent).toBe('QuestionGen');
    expect(llm.callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Property 9.c — node throw ⇒ flow aborts and failedAgent set
// ---------------------------------------------------------------------------

describe('Property 9 — exception propagation (R17.4)', () => {
  it('a thrown exception inside a node tags state.failedAgent', async () => {
    const sandbox = fakeSandbox();
    // Custom graph with an explicitly-throwing reporter override.
    const llm = {
      chat: async () => { throw new Error('boom'); },
    };
    const graph = createGraph({ llmClient: llm, sandbox });

    // Reporter requires history.length >= 5; populate enough rows.
    const initial = createInitialState({ theme: 'ecommerce' });
    const stateWithHistory = mergePartial(initial, {
      history: Array.from({ length: 5 }, (_, i) => ({
        id: `a-${i}`, questionId: 'q', sessionId: 's', submittedAt: i,
        userSql: '', userResultSummary: { rowCount: 0, columns: [], truncated: false },
        verdict: { correct: true }, tutorThread: [],
      })),
    });
    const next = await graph.runNode('reporter', stateWithHistory);
    expect(next.failedAgent).toBe('Reporter');
    expect(typeof next.error).toBe('string');
  });

  it('runNode rejects an unknown node name with a Reporter/SchemaGen-tagged failure', async () => {
    const llm = { chat: async () => ({ content: 'unused' }) };
    const sandbox = fakeSandbox();
    const graph = createGraph({ llmClient: llm, sandbox });
    const initial = createInitialState({ theme: 'ecommerce' });
    const next = await graph.runNode(/** @type {any} */ ('not-a-node'), initial);
    // The exact agent label is implementation-defined; the contract is that
    // SOME failedAgent/error are set so the UI surfaces the failure.
    expect(next.failedAgent).toBeDefined();
    expect(typeof next.error).toBe('string');
  });
});
