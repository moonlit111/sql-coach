// Persistence quota dialog (R15.6 / Property 12).
//
// Pure helper: `shouldShowExportDialog(lastOutcome)` returns true iff the
// most recent `store.set` outcome was `{ ok: false, quotaExceeded: true }`.
// The DOM renderer uses the same predicate so the test for Property 12
// can validate both the function and the DOM tree.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';

/**
 * @typedef {{ ok: true } | { ok: false, quotaExceeded?: boolean, error?: string }} StoreOutcome
 */

/**
 * Pure binding: dialog is visible iff the most recent outcome was a
 * quotaExceeded failure.
 *
 * @param {StoreOutcome | null | undefined} lastOutcome
 * @returns {boolean}
 */
export function shouldShowExportDialog(lastOutcome) {
  if (!lastOutcome || typeof lastOutcome !== 'object') return false;
  return lastOutcome.ok === false && lastOutcome.quotaExceeded === true;
}

/**
 * Idempotent renderer. Mounts/unmounts the quota dialog into `root` based
 * on the most recent `lastOutcome`.
 *
 * The dialog DOM node carries `[data-quota-dialog]` so tests can
 * `querySelector` for it without depending on class names. The export
 * button carries `[data-quota-export]` and triggers `store.exportAll()`,
 * which is downloaded as a Blob in production.
 *
 * @param {HTMLElement} root
 * @param {{
 *   lastOutcome: StoreOutcome | null,
 *   store: { exportAll: () => string },
 * }} props
 */
export function renderQuotaDialog(root, { lastOutcome, store }) {
  // Always remove the previous dialog before deciding whether to render.
  const existing = root.querySelector('[data-quota-dialog]');
  if (existing) existing.remove();

  if (!shouldShowExportDialog(lastOutcome)) return;

  const dialog = el(
    'div',
    {
      'data-quota-dialog': '',
      class: 'quota-dialog',
      role: 'alertdialog',
      'aria-modal': 'true',
    },
    el('h3', {}, ZH.quota.title),
    el('p', {}, ZH.quota.message),
    el(
      'button',
      {
        type: 'button',
        'data-quota-export': '',
        class: 'btn btn-primary',
        onClick: () => {
          try {
            const json = store.exportAll();
            triggerDownload(json, 'sql-coach-export.json');
          } catch {
            /* swallow — UI feedback happens via the toast surface */
          }
        },
      },
      ZH.quota.exportJson,
    ),
  );

  root.appendChild(dialog);
}

/**
 * Trigger a Blob download for the given JSON payload. No-op in environments
 * without a `document.createElement('a')` href workflow (e.g. headless tests
 * that don't drive the export button).
 *
 * @param {string} json
 * @param {string} filename
 */
function triggerDownload(json, filename) {
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch {
    /* environments without Blob/URL — silently skip */
  }
}

export default { shouldShowExportDialog, renderQuotaDialog };
