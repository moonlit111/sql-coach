// Single-priority error toast surface (R14.6).
//
// Centralised error sink: given a set of pending error flags from any
// source (LLM client, sandbox, persistence), render only the highest-
// priority error per Property 4's ordering. The pure helper
// `pickErrorToShow(errors)` exposes the same logic as
// llm/errors.js → `displayedError(errors)` but extends it to the
// non-LLM kinds we surface in the UI (sandbox + persistence).

import { el } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { displayedError } from '../llm/errors.js';

/**
 * Extended priority list. LLM errors come first (per Property 4), followed
 * by sandbox-level errors and persistence errors. Lower index = higher
 * priority.
 *
 * @type {readonly string[]}
 */
export const UI_ERROR_PRIORITY = Object.freeze([
  'unauthorized',
  'rate_limited',
  'server_error',
  'timeout',
  'cors',
  'network',
  'bad_response',
  'sandbox_timeout',
  'sandbox_safety',
  'sandbox_runtime',
  'persist_quota',
  'persist_error',
]);

/**
 * Pick the single highest-priority error from a set of pending errors.
 * Accepts arrays/iterables of `{ kind, message, ... }` objects from any
 * source. Returns `null` for empty/nullish input — the UI renders nothing
 * in that case (R14.6).
 *
 * @param {Iterable<{kind: string, message?: string}>|null|undefined} errors
 * @returns {{kind: string, message: string} | null}
 */
export function pickErrorToShow(errors) {
  if (errors === null || errors === undefined) return null;

  // Try the LLM-only displayedError first (it implements R14.6 verbatim
  // for LLM errors).
  const llmList = [];
  const otherList = [];
  for (const e of errors) {
    if (!e || typeof e !== 'object') continue;
    const idx = UI_ERROR_PRIORITY.indexOf(e.kind);
    if (idx < 0) continue;
    if (idx <= UI_ERROR_PRIORITY.indexOf('bad_response')) llmList.push(e);
    else otherList.push(e);
  }
  const llmPick = displayedError(llmList);
  if (llmPick) return /** @type {any} */ (llmPick);

  // Fall back to the extended list — pick lowest-index kind among the
  // remaining non-LLM errors.
  let best = null;
  let bestRank = Infinity;
  for (const e of otherList) {
    const rank = UI_ERROR_PRIORITY.indexOf(e.kind);
    if (rank >= 0 && rank < bestRank) {
      best = e;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Map a classified error to the user-facing copy. Falls back to the error's
 * own `message` field if no canonical copy exists.
 *
 * For bad_response we prefer the diagnostic message attached by the agent
 * (e.g. "SchemaGen 失败：表 user 行数不足 5") over the generic copy, so
 * users can see exactly what went wrong instead of "格式异常".
 */
function copyFor(err) {
  if (!err || typeof err !== 'object') return '';
  // Always prefer the upstream message when it is informative — otherwise
  // localised copy from ZH.errors.* is used as a fallback.
  const upstream = typeof err.message === 'string' && err.message.trim() ? err.message : '';
  switch (err.kind) {
    case 'unauthorized':    return upstream || ZH.errors.unauthorized;
    case 'rate_limited':    return upstream || ZH.errors.rateLimited;
    case 'server_error':    return upstream || ZH.errors.serverError;
    case 'timeout':         return upstream || ZH.errors.timeout;
    case 'cors':            return upstream || ZH.errors.cors;
    case 'network':         return upstream || ZH.errors.network;
    case 'bad_response':    return upstream || ZH.errors.badResponse;
    case 'sandbox_timeout': return upstream || ZH.errors.sandboxTimeout;
    case 'sandbox_safety':  return upstream || ZH.sandbox.rejectedDdl;
    case 'sandbox_runtime': return upstream;
    case 'persist_quota':   return upstream || ZH.quota.message;
    default:                return upstream;
  }
}

/**
 * Render at most one toast inside `root`. Idempotent: previous toast nodes
 * are removed before deciding what to render.
 *
 * @param {HTMLElement} root
 * @param {{
 *   errors: Iterable<{kind: string, message?: string}>|null,
 *   onDismiss?: () => void,
 * }} props
 */
export function renderErrorToast(root, { errors, onDismiss } = {}) {
  const existing = root.querySelector('[data-error-toast]');
  if (existing) existing.remove();

  const pick = pickErrorToShow(errors);
  if (!pick) return;

  const toast = el('div',
    {
      class: `error-toast error-toast-${pick.kind}`,
      role: 'alert',
      'data-error-toast': '',
      'data-error-kind': pick.kind,
    },
    el('span', { class: 'error-toast-text' }, copyFor(pick)),
    el(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost',
        'data-action': 'dismiss',
        onClick: () => { onDismiss?.(); toast.remove(); },
      },
      '关闭',
    ),
  );
  root.appendChild(toast);
}

export default { pickErrorToShow, renderErrorToast };
