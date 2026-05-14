// Feature: sql-coach, Property 7: Result-set equivalence — symmetry, reflexivity, mode correctness
// Validates: Requirements R12.1, R12.2, R12.3, R12.4, R12.5, R12.6, R19.4

import { describe, it, expect } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { compare } from '../../src/judge/compare.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbValue = fc.oneof(
  fc.integer({ min: -100, max: 100 }),
  fc.string({ maxLength: 8 }),
  fc.constant(null),
  fc.boolean(),
);

const arbRow = (n) => fc.array(arbValue, { minLength: n, maxLength: n });

const arbColumns = (n) =>
  fc.array(fc.string({ minLength: 1, maxLength: 6 }), {
    minLength: n,
    maxLength: n,
  });

/** Arbitrary result set with random column count 1..5 and 0..20 rows. */
const arbResultSet = fc.integer({ min: 1, max: 5 }).chain((n) =>
  fc.record({
    columns: arbColumns(n),
    rows: fc.array(arbRow(n), { minLength: 0, maxLength: 20 }),
  }),
);

/**
 * Arbitrary result set with DISTINCT rows, used by the sequence-vs-multiset
 * property where we need any non-identity permutation to produce a different
 * row sequence. We make rows distinct by prepending a unique integer column.
 */
const arbDistinctRowsRS = fc.integer({ min: 2, max: 8 }).chain((rowCount) =>
  fc.integer({ min: 1, max: 5 }).chain((colCount) => {
    if (colCount === 1) {
      return fc.record({
        columns: arbColumns(1),
        rows: fc.constant(
          Array.from({ length: rowCount }, (_, i) => [i]),
        ),
      });
    }
    return fc.tuple(
      arbColumns(colCount),
      fc.array(arbRow(colCount - 1), {
        minLength: rowCount,
        maxLength: rowCount,
      }),
    ).map(([cols, restRows]) => ({
      columns: cols,
      rows: restRows.map((row, i) => [i, ...row]),
    }));
  }),
);

const arbDistinctRowsRSWithPerm = arbDistinctRowsRS.chain((rs) =>
  fc
    .array(fc.nat(), {
      minLength: rs.rows.length,
      maxLength: rs.rows.length,
    })
    .map((seed) => {
      const n = rs.rows.length;
      const perm = Array.from({ length: n }, (_, i) => i);
      // Fisher-Yates seeded shuffle.
      for (let i = n - 1; i > 0; i--) {
        const j = seed[i] % (i + 1);
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      return { rs, perm };
    }),
);

const isIdentity = (p) => p.every((v, i) => v === i);

const applyPerm = (rs, perm) => ({ ...rs, rows: perm.map((i) => rs.rows[i]) });

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test.prop([arbResultSet, fc.constantFrom('multiset', 'sequence')])(
  'reflexivity: compare(rs, rs, mode) is correct',
  (rs, mode) => {
    expect(compare(rs, rs, mode).correct).toBe(true);
  },
);

test.prop([
  fc.integer({ min: 1, max: 5 }).chain((n) =>
    fc.record({
      cols1: arbColumns(n),
      cols2: arbColumns(n),
      rows: fc.array(arbRow(n), { minLength: 0, maxLength: 20 }),
    }),
  ),
  fc.constantFrom('multiset', 'sequence'),
])(
  'column-name tolerance: renaming columns of user does not affect verdict (R12.4)',
  ({ cols1, cols2, rows }, mode) => {
    const a = { columns: cols1, rows };
    const b = { columns: cols2, rows };
    expect(compare(a, b, mode).correct).toBe(true);
  },
);

test.prop([arbDistinctRowsRSWithPerm])(
  'multiset commutativity & sequence sensitivity under permutation',
  ({ rs, perm }) => {
    const shuffled = applyPerm(rs, perm);
    // Multiset always equivalent under permutation.
    expect(compare(shuffled, rs, 'multiset').correct).toBe(true);
    // Sequence: only if the permutation is non-identity, the order changes
    // and rows are distinct so the sequence comparison must reject.
    if (!isIdentity(perm)) {
      expect(compare(shuffled, rs, 'sequence').correct).toBe(false);
    } else {
      expect(compare(shuffled, rs, 'sequence').correct).toBe(true);
    }
  },
);

test.prop([
  arbResultSet,
  arbResultSet,
  fc.constantFrom('multiset', 'sequence'),
])('symmetry: compare(a,b,m).correct === compare(b,a,m).correct', (a, b, m) => {
  expect(compare(a, b, m).correct).toBe(compare(b, a, m).correct);
});

test.prop([arbResultSet, fc.constantFrom('multiset', 'sequence')])(
  'non-empty diff when one row is removed',
  (rs, mode) => {
    fc.pre(rs.rows.length >= 1);
    const truncated = { ...rs, rows: rs.rows.slice(0, -1) };
    const v = compare(truncated, rs, mode);
    expect(v.correct).toBe(false);
    const sum =
      (v.diffSummary?.extraRows ?? 0) + (v.diffSummary?.missingRows ?? 0);
    expect(sum).toBeGreaterThanOrEqual(1);
  },
);

// ---------------------------------------------------------------------------
// Targeted example tests
// ---------------------------------------------------------------------------

describe('compare — examples', () => {
  const rs = (columns, rows) => ({ columns, rows });

  it('both empty → correct', () => {
    const v = compare(rs(['a'], []), rs(['x'], []), 'multiset');
    expect(v.correct).toBe(true);
  });

  it('user missing 1 row → wrong, missingRows=1', () => {
    const user = rs(['a'], [[1], [2]]);
    const ref = rs(['a'], [[1], [2], [3]]);
    const v = compare(user, ref, 'multiset');
    expect(v.correct).toBe(false);
    expect(v.diffSummary?.missingRows).toBe(1);
    expect(v.diffSummary?.extraRows).toBe(0);
  });

  it('user extra 1 row → wrong, extraRows=1', () => {
    const user = rs(['a'], [[1], [2], [3]]);
    const ref = rs(['a'], [[1], [2]]);
    const v = compare(user, ref, 'multiset');
    expect(v.correct).toBe(false);
    expect(v.diffSummary?.extraRows).toBe(1);
    expect(v.diffSummary?.missingRows).toBe(0);
  });

  it('sequence wrong order → wrong with firstMismatch set', () => {
    const user = rs(['a'], [[2], [1]]);
    const ref = rs(['a'], [[1], [2]]);
    const v = compare(user, ref, 'sequence');
    expect(v.correct).toBe(false);
    expect(v.diffSummary?.firstMismatch).toBeDefined();
    expect(v.diffSummary?.firstMismatch?.rowIndex).toBe(0);
  });

  it('multiset same content different order → correct', () => {
    const user = rs(['a'], [[2], [1], [3]]);
    const ref = rs(['x'], [[1], [2], [3]]);
    const v = compare(user, ref, 'multiset');
    expect(v.correct).toBe(true);
  });

  it('SqlError as user → correct=false, sandboxError set', () => {
    const sqlErr = { kind: 'syntax', message: 'oops' };
    const ref = rs(['a'], [[1]]);
    const v = compare(sqlErr, ref, 'multiset');
    expect(v.correct).toBe(false);
    expect(v.sandboxError).toEqual(sqlErr);
  });

  it('column count mismatch → correct=false', () => {
    const user = rs(['a', 'b'], [[1, 2]]);
    const ref = rs(['x'], [[1]]);
    const v = compare(user, ref, 'multiset');
    expect(v.correct).toBe(false);
  });

  it('column NAME mismatch but same data → correct=true', () => {
    const user = rs(['a', 'b'], [[1, 2], [3, 4]]);
    const ref = rs(['x', 'y'], [[1, 2], [3, 4]]);
    expect(compare(user, ref, 'multiset').correct).toBe(true);
    expect(compare(user, ref, 'sequence').correct).toBe(true);
  });

  it('numeric coercion: "12" equivalent to 12 (R12.1)', () => {
    const user = rs(['a'], [['12'], ['7.5']]);
    const ref = rs(['x'], [[12], [7.5]]);
    expect(compare(user, ref, 'multiset').correct).toBe(true);
  });

  it('null and empty string remain distinct', () => {
    const user = rs(['a'], [[null]]);
    const ref = rs(['x'], [['']]);
    expect(compare(user, ref, 'multiset').correct).toBe(false);
  });
});
