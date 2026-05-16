// Feature: sqlense, Property 11: History sort, wrong-only filter, empty-state
// Validates: Requirements R15.4, R15.5

import { describe, expect, beforeEach, it } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import {
  sortDesc,
  filterWrong,
  renderHistory,
  clearHistory,
} from '../../src/ui/history-view.js';
import { createStore } from '../../src/persist/store.js';
import { PersistKey } from '../../src/persist/schema.js';

// fast-check arbitrary for AnswerRecord — we only need the fields the
// history view actually reads (submittedAt, verdict.correct, userSql, id,
// questionId).
const answerRecordArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  questionId: fc.string({ minLength: 1, maxLength: 12 }),
  sessionId: fc.string({ minLength: 1, maxLength: 12 }),
  submittedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  userSql: fc.string({ maxLength: 60 }),
  userResultSummary: fc.record({
    rowCount: fc.integer({ min: 0, max: 1000 }),
    columns: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 5 }),
    truncated: fc.boolean(),
  }),
  verdict: fc.record({ correct: fc.boolean() }),
  tutorThread: fc.constant([]),
});

describe('Property 11 — sortDesc / filterWrong are pure helpers', () => {
  // 1. sortDesc(records) is non-strict-descending by submittedAt and a
  //    permutation of the input.
  test.prop([fc.array(answerRecordArb, { maxLength: 20 })])(
    'sortDesc is descending and a permutation of the input',
    (records) => {
      const sorted = sortDesc(records);
      expect(sorted).toHaveLength(records.length);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i - 1].submittedAt).toBeGreaterThanOrEqual(
          sorted[i].submittedAt,
        );
      }
      // Permutation check via id multiset.
      const before = records.map((r) => r.id).sort();
      const after = sorted.map((r) => r.id).sort();
      expect(after).toEqual(before);
    },
  );

  // 2. filterWrong(records) is a subset and matches the count of wrong
  //    records.
  test.prop([fc.array(answerRecordArb, { maxLength: 30 })])(
    'filterWrong returns exactly the records with verdict.correct === false',
    (records) => {
      const wrong = filterWrong(records);
      const expectedCount = records.filter((r) => r.verdict.correct === false).length;
      expect(wrong.length).toBe(expectedCount);
      for (const r of wrong) {
        expect(r.verdict.correct).toBe(false);
        expect(records).toContain(r);
      }
    },
  );
});

describe('Property 11 — empty state renders the exact "没有符合条件的错题" string', () => {
  let root;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  // Empty state property: when filterWrong returns 0 records AND the user
  // has the wrong-only filter ON, the rendered DOM contains the exact
  // string "没有符合条件的错题".
  test.prop([fc.array(answerRecordArb, { maxLength: 20 })])(
    'renderHistory(filterWrong=true) shows the empty-state copy when no wrong records',
    (records) => {
      // Force the records to be all-correct so the wrong-only filter yields
      // an empty list. This isolates the empty-state branch.
      const correctOnly = records.map((r) => ({ ...r, verdict: { correct: true } }));
      root.innerHTML = '';
      renderHistory(root, { records: correctOnly, filterWrongOnly: true });
      expect(root.textContent).toContain('没有符合条件的错题');
    },
  );

  it('renderHistory(filterWrong=true) with one wrong record does NOT show empty-state copy', () => {
    root.innerHTML = '';
    renderHistory(root, {
      records: [
        {
          id: 'a1',
          questionId: 'q1',
          sessionId: 's1',
          submittedAt: 1,
          userSql: 'SELECT 1',
          userResultSummary: { rowCount: 0, columns: [], truncated: false },
          verdict: { correct: false },
          tutorThread: [],
        },
      ],
      filterWrongOnly: true,
    });
    expect(root.textContent).not.toContain('没有符合条件的错题');
  });
});

describe('Property 11 — clearHistory removes ANSWERS but preserves SETTINGS', () => {
  it('clearHistory(store) does not remove the settings key', () => {
    // Use a fresh store backed by jsdom localStorage.
    globalThis.localStorage.clear();
    const store = createStore();
    const cfg = {
      apiBaseUrl: 'https://api.example.com/v1',
      apiKey: 'secret-key',
      modelName: 'm',
    };
    store.set(PersistKey.SETTINGS, cfg);
    store.set(PersistKey.ANSWERS, [
      { id: 'a1', verdict: { correct: false }, submittedAt: 1 },
    ]);

    expect(store.get(PersistKey.SETTINGS)).not.toBeNull();
    expect(store.get(PersistKey.ANSWERS)).not.toBeNull();

    clearHistory(store);

    expect(store.get(PersistKey.ANSWERS)).toBeNull();
    expect(store.get(PersistKey.SETTINGS)).not.toBeNull();
    expect(store.get(PersistKey.SETTINGS).apiKey).toBe('secret-key');
  });
});
