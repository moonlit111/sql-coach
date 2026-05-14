// Settings module — manages the user's LLM config.
//
// Validates: Requirements R1.1, R1.2, R1.5, R1.6, R1.7, R2.1, R2.3
// Implements: design.md → "Settings_Module" interface
//
// Surface (matches design.md):
//   load()                       : LlmConfig | null
//   save(cfg)                    : void
//   clear()                      : void
//   isComplete(cfg)              : boolean   (R1.5)
//   testConnection(cfg)          : Promise<{ ok, latencyMs, error? }>  (R1.6)
//   maskApiKey(apiKey, revealed) : string    (R1.7 — pure helper)
//
// All persistence goes through the singleton `store` from src/persist/store.js
// so the in-memory fallback (R2.5) and quotaExceeded handling (R15.6) come
// for free.

import { store } from '../persist/store.js';
import { PersistKey } from '../persist/schema.js';
import { createLlmClient } from '../llm/client.js';

/**
 * @typedef {Object} LlmConfig
 * @property {string} apiBaseUrl
 * @property {string} apiKey
 * @property {string} modelName
 */

/**
 * Read the saved LlmConfig, or `null` if none has been persisted yet.
 * @returns {LlmConfig | null}
 */
export function load() {
  return store.get(PersistKey.SETTINGS);
}

/**
 * Persist the LlmConfig. Returns whatever the store reports — UI can use
 * `quotaExceeded` to surface the export-JSON dialog (R15.6).
 * @param {LlmConfig} cfg
 */
export function save(cfg) {
  return store.set(PersistKey.SETTINGS, cfg);
}

/**
 * Remove the persisted settings (R2.3). The store backs onto either real
 * `localStorage` or the in-memory fallback Map; either way, `load()` returns
 * `null` afterwards.
 */
export function clear() {
  store.remove(PersistKey.SETTINGS);
}

/**
 * R1.5 completeness check: all three required fields must be non-empty
 * (after trimming) strings. Anything else — null, undefined, non-objects,
 * missing fields, whitespace-only — is considered incomplete.
 *
 * @param {unknown} cfg
 * @returns {boolean}
 */
export function isComplete(cfg) {
  if (cfg === null || typeof cfg !== 'object') return false;
  /** @type {any} */
  const c = cfg;
  return (
    typeof c.apiBaseUrl === 'string' && c.apiBaseUrl.trim().length > 0 &&
    typeof c.apiKey     === 'string' && c.apiKey.trim().length     > 0 &&
    typeof c.modelName  === 'string' && c.modelName.trim().length  > 0
  );
}

/**
 * Issue the "测试连接" minimal request (R1.6). Returns a structured result —
 * never throws so the UI can render both branches.
 *
 * @param {LlmConfig | null | undefined} cfg
 * @returns {Promise<{ ok: boolean, latencyMs: number, sample?: string, error?: any }>}
 */
export async function testConnection(cfg) {
  if (!isComplete(cfg)) {
    return {
      ok: false,
      latencyMs: 0,
      error: { kind: 'bad_response', message: '配置不完整' },
    };
  }
  const client = createLlmClient(/** @type {LlmConfig} */ (cfg));
  return client.testConnection();
}

/**
 * R1.7 — pure helper for the "masked vs revealed" UI state. Centralised
 * here so it can be unit tested without rendering.
 *
 *   revealed=true  → return the key verbatim
 *   revealed=false → mask middle characters, keep first/last 4 visible
 *                    (or all bullets when ≤ 8 chars)
 *
 * Empty / null / undefined input → empty string (no leakage).
 *
 * @param {string | null | undefined} apiKey
 * @param {boolean} [revealed=false]
 * @returns {string}
 */
export function maskApiKey(apiKey, revealed = false) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return '';
  if (revealed) return apiKey;
  if (apiKey.length <= 8) return '•'.repeat(apiKey.length);
  // Bound the bullet run so very long keys don't render an absurd middle.
  const middleLen = Math.min(apiKey.length - 8, 20);
  return apiKey.slice(0, 4) + '•'.repeat(middleLen) + apiKey.slice(-4);
}
