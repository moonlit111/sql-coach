// Integration test for the schemaGen → questionGen → judge subset.
//
// Validates: R15.1, R15.2, R15.3, R17.1, R17.2.
//
// We avoid spinning up the real sql.js sandbox (heavy WASM in jsdom) by
// providing a fake sandbox with the same surface that
// `createGraph({ llmClient, sandbox })` consumes. The LLM is stubbed with
// canned valid JSON responses for SchemaGen and QuestionGen.
//
// The test asserts:
//   1. SchemaGen succeeds and adds `schemaSummary` to state.
//   2. QuestionGen succeeds and adds `question` to state.
//   3. Judge runs and produces a verdict (correct=true given matching
//      result sets).
//   4. An AnswerRecord round-trips through the persistence store.

import { describe, it, expect, beforeEach } from 'vitest';
import { createGraph } from '../src/orchestrator/graph.js';
import { createInitialState, mergePartial } from '../src/orchestrator/state.js';
import { createStore } from '../src/persist/store.js';
import { PersistKey } from '../src/persist/schema.js';

function fakeSandbox() {
  return {
    loadSchema: async () => ({ ok: true }),
    describeSchema: () => [
      { name: 'users',    columns: [{ name: 'id', type: 'INT', nullable: false }],
        primaryKey: ['id'], foreignKeys: [] },
      { name: 'orders',   columns: [{ name: 'id', type: 'INT', nullable: false }],
        primaryKey: ['id'], foreignKeys: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }] },
      { name: 'products', columns: [{ name: 'id', type: 'INT', nullable: false }],
        primaryKey: ['id'], foreignKeys: [] },
    ],
    exec: async (sql) => {
      // SchemaGen post-validator: SELECT COUNT(*) FROM "<table>" → ≥5 rows.
      if (/^\s*SELECT\s+COUNT\(\*\)/i.test(sql)) {
        return { columns: ['c'], rows: [[5]] };
      }
      // refSql / userSql: return a canned non-empty result.
      return { columns: ['id'], rows: [[1], [2], [3]] };
    },
  };
}

function cannedClient(content) {
  let i = 0;
  return {
    chat: async () => {
      const v = Array.isArray(content) ? content[Math.min(i, content.length - 1)] : content;
      i++;
      return { content: typeof v === 'function' ? v() : v };
    },
  };
}

const VALID_SCHEMA = JSON.stringify({
  ddl:
    'CREATE TABLE users (id INT PRIMARY KEY); ' +
    'CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, FOREIGN KEY (user_id) REFERENCES users(id)); ' +
    'CREATE TABLE products (id INT PRIMARY KEY)',
  seedSql: 'INSERT INTO users VALUES (1)',
});

const VALID_QUESTION = JSON.stringify({
  prompt: '查询所有用户的 id',
  refSql: 'SELECT id FROM users',
  topics: ['single_table_select'],
  is_ordered: false,
});

describe('Integration: schemaGen → questionGen → judge', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('runs the full subset and persists an AnswerRecord round-trip', async () => {
    const sandbox = fakeSandbox();
    const llm = cannedClient([VALID_SCHEMA, VALID_QUESTION]);
    const graph = createGraph({ llmClient: llm, sandbox });

    let state = createInitialState({
      llm: { apiBaseUrl: 'https://x.example/v1', apiKey: 'k', modelName: 'm' },
      theme: 'ecommerce',
    });

    // Stage 1: SchemaGen
    state = await graph.runNode('schemaGen', state);
    expect(state.failedAgent).toBeUndefined();
    expect(state.schemaSummary).toBeDefined();

    // Stage 2: QuestionGen
    state = mergePartial(state, {
      requestedDifficulty: 'L1',
      requestedTopics: ['single_table_select'],
    });
    state = await graph.runNode('questionGen', state);
    expect(state.failedAgent).toBeUndefined();
    expect(state.question).toBeDefined();
    expect(state.question.refSql).toBe('SELECT id FROM users');

    // Stage 3: Judge — user submits the same SQL; verdict.correct=true.
    state = mergePartial(state, { userSql: 'SELECT id FROM users' });
    state = await graph.runNode('judge', state);
    expect(state.failedAgent).toBeUndefined();
    expect(state.verdict).toBeDefined();
    expect(state.verdict.correct).toBe(true);

    // Stage 4: Persist an AnswerRecord and reload it.
    const store = createStore();
    /** @type {import('../src/types.js').AnswerRecord} */
    const record = {
      id: 'a-1',
      questionId: state.question.id,
      sessionId: state.sessionId,
      submittedAt: Date.now(),
      userSql: state.userSql,
      userResultSummary: { rowCount: 3, columns: ['id'], truncated: false },
      verdict: state.verdict,
      tutorThread: [],
    };
    const setOut = store.set(PersistKey.ANSWERS, [record]);
    expect(setOut.ok).toBe(true);

    const reload = createStore();
    const loaded = reload.get(PersistKey.ANSWERS);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('a-1');
    expect(loaded[0].verdict.correct).toBe(true);
    expect(loaded[0].userSql).toBe('SELECT id FROM users');
  });

  it('judge returns correct=false when user SQL produces a different result', async () => {
    // We craft a sandbox whose exec returns DIFFERENT rows for userSql vs
    // refSql so we can validate the wrong-answer path of the integration.
    const sandbox = {
      loadSchema: async () => ({ ok: true }),
      describeSchema: () => [
        { name: 'users',    columns: [{ name: 'id', type: 'INT', nullable: false }],
          primaryKey: ['id'], foreignKeys: [] },
        { name: 'orders',   columns: [{ name: 'id', type: 'INT', nullable: false }],
          primaryKey: ['id'], foreignKeys: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }] },
        { name: 'products', columns: [{ name: 'id', type: 'INT', nullable: false }],
          primaryKey: ['id'], foreignKeys: [] },
      ],
      exec: async (sql) => {
        if (/^\s*SELECT\s+COUNT\(\*\)/i.test(sql)) {
          return { columns: ['c'], rows: [[5]] };
        }
        if (sql === 'SELECT id FROM users') return { columns: ['id'], rows: [[1], [2], [3]] };
        return { columns: ['id'], rows: [[7]] }; // wrong
      },
    };
    const llm = cannedClient([VALID_SCHEMA, VALID_QUESTION]);
    const graph = createGraph({ llmClient: llm, sandbox });

    let state = createInitialState({
      llm: { apiBaseUrl: 'https://x.example/v1', apiKey: 'k', modelName: 'm' },
      theme: 'ecommerce',
    });
    state = await graph.runNode('schemaGen', state);
    state = mergePartial(state, { requestedDifficulty: 'L1', requestedTopics: ['single_table_select'] });
    state = await graph.runNode('questionGen', state);
    state = mergePartial(state, { userSql: 'SELECT id FROM customers' });
    state = await graph.runNode('judge', state);
    expect(state.verdict.correct).toBe(false);
    expect(state.verdict.diffSummary).toBeDefined();
  });
});
