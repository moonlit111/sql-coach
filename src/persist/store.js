// localStorage-backed key/value store with in-memory fallback.
// Validates: R2.1, R2.5, R15.1, R15.2, R15.6

import { PersistKey } from './schema.js';

/**
 * Build a fresh `Store`. Probes `localStorage` on construction; if access
 * throws (privacy-mode browsers, sandboxed WebViews — R2.5) it falls back
 * to an in-process `Map` adapter. The fallback flag is exposed for the UI
 * so a banner can be rendered.
 *
 * The interface contract matches `design.md` → `Persistence Store`:
 *   - get(key)            : T | null
 *   - set(key, value)     : { ok, quotaExceeded? }
 *   - remove(key)         : void
 *   - exportAll()         : string  (JSON)
 *   - importAll(json)     : { ok, error? }
 *   - usingFallback       : boolean
 */
export function createStore() {
  /** @type {Storage} */
  let backing;
  let usingFallback = false;

  // Probe localStorage availability with a write/remove pair (R2.5).
  // Both the *property access* (`globalThis.localStorage`) and the
  // `setItem` call can throw in sandboxed environments, so the entire
  // probe sits in one try/catch.
  try {
    const ls = globalThis.localStorage;
    const probe = '__sqlcoach_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    backing = ls;
  } catch (_e) {
    usingFallback = true;
    const map = new Map();
    backing = /** @type {Storage} */ ({
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
      clear: () => { map.clear(); },
      get length() { return map.size; },
      key: (i) => Array.from(map.keys())[i] ?? null,
    });
  }

  /**
   * @template T
   * @param {string} key
   * @returns {T | null}
   */
  function get(key) {
    const raw = backing.getItem(key);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch (_e) {
      // Corrupted entry — surface as missing so callers don't crash. The
      // raw value will be overwritten on the next successful set.
      return null;
    }
  }

  /**
   * @template T
   * @param {string} key
   * @param {T} value
   * @returns {{ ok: boolean, quotaExceeded?: boolean, error?: string }}
   */
  function set(key, value) {
    try {
      backing.setItem(key, JSON.stringify(value));
      return { ok: true };
    } catch (e) {
      // R15.6 — detect QuotaExceededError across browsers; never throw
      // past the caller. Different engines surface it differently:
      //   - DOMException name 'QuotaExceededError' (modern Chromium/Firefox)
      //   - code 22 (Chromium)
      //   - code 1014 'NS_ERROR_DOM_QUOTA_REACHED' (Firefox legacy)
      //   - message contains 'quota' (Safari fallback)
      const isQuota =
        e && (
          e.name === 'QuotaExceededError' ||
          e.code === 22 ||
          e.code === 1014 ||
          /quota/i.test(String(e.message ?? ''))
        );
      if (isQuota) return { ok: false, quotaExceeded: true };
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  /** @param {string} key */
  function remove(key) {
    backing.removeItem(key);
  }

  /**
   * Snapshot of all SQL Coach keys as a JSON string. Used by the UI's
   * "导出 JSON" dialog when persistence fills up (R15.6).
   * @returns {string}
   */
  function exportAll() {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.values(PersistKey)) {
      const v = get(k);
      if (v !== null) out[k] = v;
    }
    return JSON.stringify(out, null, 2);
  }

  /**
   * Restore from a previously exported JSON string. Only known persist
   * keys are written back — any extras in the payload are ignored.
   * @param {string} json
   * @returns {{ ok: boolean, error?: string }}
   */
  function importAll(json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed === null || typeof parsed !== 'object') {
        return { ok: false, error: 'expected a JSON object at top level' };
      }
      for (const k of Object.values(PersistKey)) {
        if (k in parsed) set(k, parsed[k]);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  return {
    get,
    set,
    remove,
    exportAll,
    importAll,
    get usingFallback() { return usingFallback; },
  };
}

/**
 * Default singleton — the app uses this everywhere. Tests can build their
 * own isolated stores with `createStore()` to avoid leaking state across
 * test cases.
 */
export const store = createStore();
