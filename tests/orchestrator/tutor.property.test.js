// Feature: sql-coach, Property 10: Tutor context isolation and persistence round-trip
// Validates: Requirements R13.3, R13.4, R13.5, R15.1, R15.2, R15.3
//
// Tests two intertwined invariants:
//
//  (1) Per-question thread isolation (R13.5):
//      after a multi-turn conversation on q1, calling
//      `tutor.resetForNewQuestion()` and then `tutor.firstMessage(state)`
//      for q2 produces a `messages` payload that contains NO substring of
//      q1.userSql or q1.refSql.
//
//  (2) Multi-turn persistence (R13.3 / R13.4):
//      every i-th follow-up turn (i ≥ 2) sends a `messages` array that
//      contains every prior turn's content.
//
//  (3) Persistence round-trip (R15.1 / R15.2 / R15.3):
//      arbitrary Question/AnswerRecord pairs survive a `store.set / get`
//      cycle (deep equality).
//
// We use a recording fake `llmClient` rather than MSW so the test stays
// fully deterministic and synchronous.

import { describe, it, expect, beforeEach } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { createTutorNode } from '../../src/orchestrator/nodes/tutor.js';
import { mergePartial } from '../../src/orchestrator/state.js';
import { createStore } from '../../src/persist/store.js';
import { PersistKey } from '../../src/persist/schema.js';

// ---------------------------------------------------------------------------
// Recording LLM client — captures every call for assertions.
// ---------------------------------------------------------------------------

function recordingClient(replies = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    chat: async (messages) => {
      calls.push(messages);
      const reply = replies[i] ?? 'reply ' + i;
      i += 1;
      return { content: reply };
    },
  };
}

const baseQuestion = (overrides = {}) => ({
  id: 'q-1',
  createdAt: 1,
  difficulty: 'L2',
  topics: ['single_table_select'],
  prompt: '查询所有 users 的 id',
  refSql: 'SELECT id FROM users',
  expectedResult: { columns: ['id'], rows: [[1], [2]] },
  isOrdered: false,
  schemaRef: 'current',
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1) R13.3 — multi-turn context retention
// ---------------------------------------------------------------------------

describe('Tutor — multi-turn context retention (R13.3 / R13.4)', () => {
  it('every follow-up turn after the first sends all prior messages', async () => {
    const llm = recordingClient(['首条诊断', 'turn1 reply', 'turn2 reply']);
    const tutor = createTutorNode({ llmClient: llm });

    let state = {
      question: baseQuestion(),
      userSql: 'SELECT id FROM user',
      verdict: { correct: false, diffSummary: { extraRows: 0, missingRows: 1 } },
      tutorThread: [],
      sessionId: 's', llm: {}, theme: 'campus', history: [],
    };

    // First diagnostic
    state = mergePartial(state, await tutor.firstMessage(state));
    expect(state.tutorThread).toHaveLength(1);
    expect(state.tutorThread[0].role).toBe('assistant');

    // Follow-up #1
    state = mergePartial(state, await tutor.followup(state, '为什么我错了？'));
    // Inspect the messages sent on the SECOND chat() call (the followup).
    const secondCall = llm.calls[1];
    // The followup's messages must contain the assistant's first reply.
    const hasFirstAssistant = secondCall.some(
      (m) => m.role === 'assistant' && m.content === '首条诊断',
    );
    expect(hasFirstAssistant).toBe(true);

    // Follow-up #2
    state = mergePartial(state, await tutor.followup(state, '能否给个例子？'));
    const thirdCall = llm.calls[2];
    // Third call must contain ALL prior turns.
    const priorContents = ['首条诊断', '为什么我错了？', 'turn1 reply'];
    for (const c of priorContents) {
      expect(thirdCall.some((m) => m.content === c)).toBe(true);
    }
    // And the new user message.
    expect(thirdCall.some((m) => m.role === 'user' && m.content === '能否给个例子？')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2) R13.5 — context isolation across question switches
// ---------------------------------------------------------------------------

describe('Tutor — context isolation on question switch (R13.5)', () => {
  test.prop(
    {
      q1Sql:  fc.constantFrom('SELECT one_secret FROM t1', 'SELECT 41+1 FROM secret_t'),
      q1Ref:  fc.constantFrom('SELECT a_classified FROM r', 'SELECT confidential_col FROM r2'),
      turns:  fc.integer({ min: 1, max: 4 }),
    },
    { numRuns: 25 },
  )(
    'q2 first turn carries no substring of q1.userSql or q1.refSql',
    async ({ q1Sql, q1Ref, turns }) => {
      const llm = recordingClient(
        Array.from({ length: 20 }, (_, i) => 'reply ' + i),
      );
      const tutor = createTutorNode({ llmClient: llm });

      // ---- Conversation on q1 ----
      let state = {
        question: baseQuestion({ id: 'q-1', refSql: q1Ref }),
        userSql: q1Sql,
        verdict: { correct: false, diffSummary: { extraRows: 0, missingRows: 1 } },
        tutorThread: [],
        sessionId: 's', llm: {}, theme: 'campus', history: [],
      };
      state = mergePartial(state, await tutor.firstMessage(state));
      for (let i = 0; i < turns; i++) {
        state = mergePartial(state, await tutor.followup(state, `q1-followup-${i}`));
      }

      const callsBeforeSwitch = llm.calls.length;

      // ---- Switch to q2: reset thread, then first message ----
      state = mergePartial(state, tutor.resetForNewQuestion());
      // Move on to q2 with a totally different SQL/refSql.
      state = mergePartial(state, {
        question: baseQuestion({
          id: 'q-2',
          prompt: '查询全部商品的 id',
          refSql: 'SELECT id FROM products',
        }),
        userSql: 'SELECT id FROM products',
        verdict: { correct: false, diffSummary: { extraRows: 0, missingRows: 1 } },
      });
      state = mergePartial(state, await tutor.firstMessage(state));

      // Inspect the very first chat() call AFTER the switch — it must not
      // mention q1.
      const q2FirstCall = llm.calls[callsBeforeSwitch];
      const flat = q2FirstCall.map((m) => m.content).join('\n');
      expect(flat.includes(q1Sql)).toBe(false);
      expect(flat.includes(q1Ref)).toBe(false);
    },
  );

  it('resetForNewQuestion empties tutorThread synchronously', () => {
    const llm = recordingClient([]);
    const tutor = createTutorNode({ llmClient: llm });
    const partial = tutor.resetForNewQuestion();
    expect(partial).toEqual({ tutorThread: [] });
  });
});

// ---------------------------------------------------------------------------
// 3) R15.1 / R15.2 / R15.3 — persistence round-trip on arbitrary records
// ---------------------------------------------------------------------------

describe('Persistence round-trip — Question / AnswerRecord (R15.1–R15.3)', () => {
  beforeEach(() => {
    try { globalThis.localStorage?.clear(); } catch { /* ignore */ }
  });

  const arbValue = fc.oneof(
    fc.integer({ min: -100, max: 100 }),
    fc.string({ maxLength: 8 }),
    fc.constant(null),
    fc.boolean(),
  );

  const arbResultSet = fc.record({
    columns: fc.array(fc.string({ minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 4 }),
    rows: fc.array(
      fc.array(arbValue, { minLength: 1, maxLength: 4 }),
      { minLength: 0, maxLength: 8 },
    ),
  });

  const arbQuestion = fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    createdAt: fc.integer({ min: 0, max: 9_999_999_999_999 }),
    difficulty: fc.constantFrom('L1', 'L2', 'L3', 'L4'),
    topics: fc.array(fc.constantFrom('single_table_select', 'join_inner', 'group_by_having'),
      { minLength: 1, maxLength: 3 }),
    prompt: fc.string({ minLength: 1, maxLength: 30 }),
    refSql: fc.string({ minLength: 1, maxLength: 50 }),
    expectedResult: arbResultSet,
    isOrdered: fc.boolean(),
    schemaRef: fc.string({ minLength: 1, maxLength: 12 }),
  });

  const arbAnswer = fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    questionId: fc.string({ minLength: 1, maxLength: 12 }),
    sessionId: fc.string({ minLength: 1, maxLength: 12 }),
    submittedAt: fc.integer({ min: 0, max: 9_999_999_999_999 }),
    userSql: fc.string({ minLength: 0, maxLength: 30 }),
    userResultSummary: fc.record({
      rowCount: fc.integer({ min: 0, max: 100 }),
      columns: fc.array(fc.string({ minLength: 1, maxLength: 5 }),
        { minLength: 0, maxLength: 4 }),
      truncated: fc.boolean(),
    }),
    verdict: fc.record({ correct: fc.boolean() }),
    tutorThread: fc.array(
      fc.record({
        role: fc.constantFrom('user', 'assistant'),
        content: fc.string({ maxLength: 30 }),
        at: fc.integer({ min: 0, max: 9_999_999_999_999 }),
      }),
      { minLength: 0, maxLength: 5 },
    ),
  });

  test.prop({ q: arbQuestion }, { numRuns: 50 })(
    'Question survives store.set → reload → store.get with deep equality',
    ({ q }) => {
      const s = createStore();
      s.set(PersistKey.QUESTION_BANK, { 's': [q] });
      // Build a fresh store instance — same backing localStorage, fresh
      // adapter — to simulate a page reload.
      const s2 = createStore();
      const got = s2.get(PersistKey.QUESTION_BANK);
      expect(got).toEqual({ 's': [q] });
      // Cleanup so the next iteration starts empty.
      s2.remove(PersistKey.QUESTION_BANK);
    },
  );

  test.prop({ records: fc.array(arbAnswer, { minLength: 1, maxLength: 5 }) }, { numRuns: 50 })(
    'AnswerRecord[] survives a round-trip with deep equality',
    ({ records }) => {
      const s = createStore();
      s.set(PersistKey.ANSWERS, records);
      const s2 = createStore();
      expect(s2.get(PersistKey.ANSWERS)).toEqual(records);
      s2.remove(PersistKey.ANSWERS);
    },
  );
});
