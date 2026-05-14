// State preservation on failure (task 13.4*).
//
// Validates: R14.5 — failure paths only ADD `failedAgent`/`error`, never
// strip user-visible context (`question`, `userSql`, `userSqlAlt`,
// `tutorThread`, `verdict`, `history`, ...).
//
// Pure unit tests — no LLM, no sandbox.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  mergePartial,
  withFailure,
  resetTutorForNewQuestion,
} from '../../src/orchestrator/state.js';

const llm = {
  apiBaseUrl: 'https://api.example.com/v1',
  apiKey:     'sk-secret',
  modelName:  'gpt-test',
};

const fixture = () => {
  const base = createInitialState({
    llm,
    theme: 'campus',
    sessionId: 'fixed-session',
  });
  return mergePartial(base, {
    ddl:           'CREATE TABLE t (id INT PRIMARY KEY)',
    seedSql:       'INSERT INTO t VALUES (1)',
    schemaSummary: [{ name: 't', columns: [], primaryKey: ['id'], foreignKeys: [] }],
    question: {
      id: 'q-1', createdAt: 0, difficulty: 'L1', topics: ['single_table_select'],
      prompt: '查询 id', refSql: 'SELECT id FROM t',
      expectedResult: { columns: ['id'], rows: [[1]] },
      isOrdered: false, schemaRef: 'current',
    },
    userSql:    'SELECT id FROM t',
    userSqlAlt: undefined,
    verdict:    { correct: false, diffSummary: { extraRows: 0, missingRows: 1 } },
    tutorThread: [{ role: 'assistant', content: 'hi', at: 1 }],
  });
};

describe('AgentState — createInitialState', () => {
  it('produces a state with the requested fields and an empty history', () => {
    const s = createInitialState({ llm, theme: 'library', sessionId: 'sess-1' });
    expect(s.llm).toBe(llm);
    expect(s.theme).toBe('library');
    expect(s.sessionId).toBe('sess-1');
    expect(s.history).toEqual([]);
  });

  it('falls back to a synthesised sessionId when none is provided', () => {
    const s = createInitialState({ llm, theme: 'ecommerce' });
    expect(typeof s.sessionId).toBe('string');
    expect(s.sessionId.length).toBeGreaterThan(0);
  });

  it('keeps themeDescription only when supplied', () => {
    const s1 = createInitialState({ llm, theme: 'custom', themeDescription: '我的业务' });
    expect(s1.themeDescription).toBe('我的业务');
    const s2 = createInitialState({ llm, theme: 'campus' });
    expect('themeDescription' in s2).toBe(false);
  });
});

describe('mergePartial — immutable spread', () => {
  it('returns a new object and does not mutate the input', () => {
    const s = fixture();
    const before = JSON.stringify(s);
    const next = mergePartial(s, { userSql: 'SELECT 2' });
    expect(JSON.stringify(s)).toBe(before);
    expect(next).not.toBe(s);
    expect(next.userSql).toBe('SELECT 2');
  });

  it('is a no-op for nullish or non-object payloads', () => {
    const s = fixture();
    expect(mergePartial(s, null)).toBe(s);
    expect(mergePartial(s, undefined)).toBe(s);
    expect(mergePartial(s, 42)).toBe(s);
  });
});

describe('withFailure — R14.5: only ADDs failure flags, never strips context', () => {
  it('preserves question, userSql, userSqlAlt, tutorThread, verdict, history', () => {
    const s = fixture();
    const next = withFailure(s, 'Tutor', 'oops');
    // Failure flags added.
    expect(next.failedAgent).toBe('Tutor');
    expect(next.error).toBe('oops');
    // Everything else preserved by reference equality on each field.
    expect(next.question).toBe(s.question);
    expect(next.userSql).toBe(s.userSql);
    expect(next.tutorThread).toBe(s.tutorThread);
    expect(next.verdict).toBe(s.verdict);
    expect(next.history).toBe(s.history);
    expect(next.schemaSummary).toBe(s.schemaSummary);
    expect(next.ddl).toBe(s.ddl);
    expect(next.seedSql).toBe(s.seedSql);
  });

  it('accepts a ClassifiedLlmError as the error payload', () => {
    const s = fixture();
    const err = { kind: 'timeout', message: 'request timed out' };
    const next = withFailure(s, 'QuestionGen', err);
    expect(next.error).toBe(err);
  });

  it('does not mutate the input state', () => {
    const s = fixture();
    const before = JSON.stringify(s);
    withFailure(s, 'Judge', 'boom');
    expect(JSON.stringify(s)).toBe(before);
    expect(s.failedAgent).toBeUndefined();
    expect(s.error).toBeUndefined();
  });
});

describe('resetTutorForNewQuestion (R13.5)', () => {
  it('returns a Partial<state> that empties tutorThread', () => {
    const partial = resetTutorForNewQuestion();
    expect(partial).toEqual({ tutorThread: [] });
    const s = fixture();
    const next = mergePartial(s, partial);
    expect(next.tutorThread).toEqual([]);
    // The rest of the state survives.
    expect(next.question).toBe(s.question);
    expect(next.userSql).toBe(s.userSql);
  });
});
