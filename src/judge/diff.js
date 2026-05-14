// Result-set diff summariser used by the Judge engine.
//
// Validates: R12.6 — when the user result and reference result are not
// equivalent, the verdict carries `{ extraRows, missingRows, firstMismatch }`
// so the UI can show a useful failure message without dumping the whole
// result set.

import { rowKey } from './normalize.js';

/**
 * @typedef {import('../types.js').ResultSet} ResultSet
 * @typedef {import('../types.js').JudgeDiffSummary} JudgeDiffSummary
 */

/**
 * Build a diff summary between user and reference result sets.
 *
 * `firstMismatch` is only populated for `'sequence'` mode (per the design's
 * Judge engine note: under multiset semantics there is no canonical "first"
 * mismatched row).
 *
 * @param {ResultSet | null | undefined} user
 * @param {ResultSet | null | undefined} ref
 * @param {'multiset' | 'sequence'} mode
 * @returns {JudgeDiffSummary}
 */
export function summarize(user, ref, mode) {
  const userRows = user?.rows ?? [];
  const refRows = ref?.rows ?? [];

  if (mode === 'sequence') {
    let firstMismatch;
    const max = Math.max(userRows.length, refRows.length);
    for (let i = 0; i < max; i++) {
      const u = userRows[i];
      const r = refRows[i];
      if (
        u === undefined ||
        r === undefined ||
        rowKey(u) !== rowKey(r)
      ) {
        firstMismatch = {
          rowIndex: i,
          expected: r ?? null,
          actual: u ?? null,
        };
        break;
      }
    }
    /** @type {JudgeDiffSummary} */
    const out = {
      extraRows: Math.max(0, userRows.length - refRows.length),
      missingRows: Math.max(0, refRows.length - userRows.length),
    };
    if (firstMismatch) out.firstMismatch = firstMismatch;
    return out;
  }

  // multiset: count canonical keys on both sides and report excess on each.
  const userMap = new Map();
  const refMap = new Map();
  for (const r of userRows) {
    const k = rowKey(r);
    userMap.set(k, (userMap.get(k) ?? 0) + 1);
  }
  for (const r of refRows) {
    const k = rowKey(r);
    refMap.set(k, (refMap.get(k) ?? 0) + 1);
  }

  let extra = 0;
  let missing = 0;
  for (const [k, c] of userMap) {
    const rc = refMap.get(k) ?? 0;
    if (c > rc) extra += c - rc;
  }
  for (const [k, c] of refMap) {
    const uc = userMap.get(k) ?? 0;
    if (c > uc) missing += c - uc;
  }
  return { extraRows: extra, missingRows: missing };
}
