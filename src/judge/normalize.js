// SQL value normalisation used by the Judge engine.
//
// The Judge runs entirely in the browser (R12, design D4) and compares
// result sets returned by sql.js against reference result sets persisted by
// QuestionGen. Different SQL engines (and even the same engine across
// queries) can spell the same value differently — `12` vs `12.0`, BLOBs as
// Uint8Array, booleans as 0/1. `normalizeValue` collapses those to a small
// tagged shape so downstream `rowKey` / `compare` becomes a purely
// structural comparison.
//
// Validates: R12.1 (column-value semantic equivalence), R12.4 (column types
// must be comparable, names are advisory).

/**
 * Normalise a single SQL value into a tagged, JSON-serialisable shape.
 * The output is an object `{ __t, v }` where `__t` is one of
 * `'num' | 'str' | 'null' | 'blob'` and `v` is a primitive comparable value.
 *
 * @param {any} v
 * @returns {{ __t: 'num' | 'str' | 'null' | 'blob', v?: number | string }}
 */
export function normalizeValue(v) {
  if (v === null || v === undefined) return { __t: 'null' };
  if (typeof v === 'boolean') return { __t: 'num', v: v ? 1 : 0 };
  if (typeof v === 'number') {
    // NaN / Infinity are not representable in JSON; fall back to the
    // string form so two NaN result-set cells still compare equal.
    if (!Number.isFinite(v)) return { __t: 'str', v: String(v) };
    return { __t: 'num', v };
  }
  if (typeof v === 'bigint') return { __t: 'num', v: Number(v) };
  if (v instanceof Uint8Array) {
    let bin = '';
    for (let i = 0; i < v.length; i++) bin += String.fromCharCode(v[i]);
    return { __t: 'blob', v: btoa(bin) };
  }
  if (typeof v === 'string') {
    // Numeric-looking strings collapse to numbers so `12 == "12"` (R12.1).
    // Be conservative: only accept canonical decimal forms with no leading
    // zeros, no scientific notation, and no surrounding whitespace beyond
    // basic trim — anything else is treated as text.
    const trimmed = v.trim();
    if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return { __t: 'num', v: n };
    }
    return { __t: 'str', v };
  }
  return { __t: 'str', v: JSON.stringify(v) };
}

/**
 * Canonical key for a row, suitable for `Map`-based multiset comparison.
 * Two rows produce identical keys iff every cell is `normalizeValue`-equal.
 *
 * @param {any[]} row
 * @returns {string}
 */
export function rowKey(row) {
  return JSON.stringify(row.map(normalizeValue));
}

/**
 * Apply `normalizeValue` element-wise — handy for diagnostic output.
 *
 * @param {any[]} row
 */
export function normalizeRow(row) {
  return row.map(normalizeValue);
}
