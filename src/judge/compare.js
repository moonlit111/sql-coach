// Result-set equivalence comparator used by Judge_Agent.
//
// Pure function, no LLM, no I/O — see design D4. The Judge_Agent thin
// wrapper picks `mode` from `question.isOrdered` (R19.4) and delegates to
// `compare`. For `set_vs_join_compare` (R12.8), the orchestrator calls
// `compare` twice (once per submitted SQL) and AND-combines the verdicts.
//
// Validates: R12.1, R12.2, R12.3, R12.4, R12.5, R12.6, R12.7 (Property 7).

import { rowKey } from './normalize.js';
import { summarize } from './diff.js';

/**
 * @typedef {import('../types.js').ResultSet} ResultSet
 * @typedef {import('../types.js').SqlError} SqlError
 * @typedef {import('../types.js').JudgeVerdict} JudgeVerdict
 */

/**
 * Heuristic: does this look like a `SqlError` rather than a `ResultSet`?
 * @param {*} x
 */
function isSqlError(x) {
  return (
    x !== null &&
    typeof x === 'object' &&
    typeof x.kind === 'string' &&
    typeof x.message === 'string' &&
    !('rows' in x)
  );
}

/**
 * Compare a user result set against a reference result set.
 *
 * @param {ResultSet | SqlError} user
 * @param {ResultSet} ref
 * @param {'multiset' | 'sequence'} mode
 * @returns {JudgeVerdict}
 */
export function compare(user, ref, mode) {
  // R12.7 — sandbox-side execution failure short-circuits the verdict and
  // forwards the original error so the UI / Tutor can mention it.
  if (isSqlError(user)) {
    return { correct: false, sandboxError: /** @type {SqlError} */ (user) };
  }
  if (!user || !ref) return { correct: false };

  const userRS = /** @type {ResultSet} */ (user);

  // Column count must match (R12.1, R12.4 — names are advisory).
  if ((userRS.columns?.length ?? 0) !== (ref.columns?.length ?? 0)) {
    return { correct: false, diffSummary: summarize(userRS, ref, mode) };
  }

  if (mode === 'sequence') {
    if (userRS.rows.length !== ref.rows.length) {
      return { correct: false, diffSummary: summarize(userRS, ref, mode) };
    }
    for (let i = 0; i < ref.rows.length; i++) {
      if (rowKey(userRS.rows[i]) !== rowKey(ref.rows[i])) {
        return { correct: false, diffSummary: summarize(userRS, ref, mode) };
      }
    }
    return { correct: true };
  }

  // multiset: row counts must match, and every reference row must be
  // accounted for in the user-side bag.
  if (userRS.rows.length !== ref.rows.length) {
    return { correct: false, diffSummary: summarize(userRS, ref, mode) };
  }
  /** @type {Map<string, number>} */
  const userMap = new Map();
  for (const r of userRS.rows) {
    const k = rowKey(r);
    userMap.set(k, (userMap.get(k) ?? 0) + 1);
  }
  for (const r of ref.rows) {
    const k = rowKey(r);
    const c = userMap.get(k) ?? 0;
    if (c <= 0) {
      return { correct: false, diffSummary: summarize(userRS, ref, mode) };
    }
    userMap.set(k, c - 1);
  }
  return { correct: true };
}
