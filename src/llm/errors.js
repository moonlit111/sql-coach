// LLM error classification for SQL Coach.
//
// Validates: Requirements R3.1, R3.3, R14.1, R14.2, R14.3, R14.4, R14.6
// Implements: design.md → Property 4 (LLM error classification + priority)
//
// Two pure helpers:
//   - classifyError(input):   Response-shaped object | Error | other → ClassifiedLlmError
//   - displayedError(errors): set/array of ClassifiedLlmError → highest-priority one (or null)

/**
 * @typedef {Object} ClassifiedLlmError
 * @property {'unauthorized'|'rate_limited'|'server_error'|'timeout'|'cors'|'network'|'bad_response'} kind
 * @property {number=} status
 * @property {number=} retryAfterMs
 * @property {string} message
 */

/**
 * Display priority — lower index means higher priority.
 * R14.6: "unauthorized > rate_limited > server_error > timeout > cors > network > bad_response".
 */
export const LLM_ERROR_PRIORITY = Object.freeze([
  'unauthorized',
  'rate_limited',
  'server_error',
  'timeout',
  'cors',
  'network',
  'bad_response',
]);

/**
 * Classify either a fetch `Response`-shaped value or a thrown error/exception.
 *
 * Accepts:
 *   - a Response-like object: `{ status: number, headers?: { get(name): string|null } }`
 *     (a real `Response` qualifies; so does our test fake)
 *   - a thrown `Error` (including `AbortError`, `TypeError`, ...)
 *   - anything else falls through to `bad_response`
 *
 * @param {unknown} input
 * @returns {ClassifiedLlmError}
 */
export function classifyError(input) {
  // Case 1: Response-shaped object (has a numeric `status` field).
  if (
    input !== null &&
    typeof input === 'object' &&
    'status' in input &&
    typeof /** @type {any} */ (input).status === 'number'
  ) {
    const r = /** @type {{status:number, headers?:{get?:(k:string)=>string|null}}} */ (
      input
    );
    const status = r.status;

    if (status === 401 || status === 403) {
      return {
        kind: 'unauthorized',
        status,
        message: 'API Key 无效或无权限',
      };
    }

    if (status === 429) {
      const retryAfterMs = parseRetryAfter(r.headers);
      const out = {
        kind: 'rate_limited',
        status: 429,
        message: '请求被限流，请稍后重试',
      };
      if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
      return out;
    }

    if (status >= 500 && status < 600) {
      return {
        kind: 'server_error',
        status,
        message: 'LLM 服务端错误',
      };
    }

    // Any other status reaching this classifier (e.g. 400 with malformed body)
    // is treated as a bad/unhandled response.
    return {
      kind: 'bad_response',
      status,
      message: `Unexpected HTTP status ${status}`,
    };
  }

  // Case 2: thrown Error (or DOMException-shaped). AbortError → timeout
  // (R3.3 / R14.4); TypeError → CORS (R3.1, the standard fetch CORS signal).
  if (input instanceof Error || (input && typeof input === 'object' && 'name' in input)) {
    const e = /** @type {Error} */ (input);
    const name = e.name;
    const msg = String(e.message ?? e);

    if (name === 'AbortError') {
      return { kind: 'timeout', message: '请求超时' };
    }
    if (name === 'TypeError') {
      // R3.1: the message must contain the literal "CORS" so the UI surfaces it.
      // But honest about the ambiguity — TypeError("Failed to fetch") could be
      // CORS, DNS failure, unreachable host, or wrong URL. Browsers deliberately
      // hide which one it is.
      return {
        kind: 'cors',
        message:
          '请求未能完成。可能原因：(1) CORS 跨域被拒；(2) API 地址打错或端点不可达；(3) 网络/DNS 问题。请先检查 API Base URL 是否正确，再确认端点是否允许跨域。',
      };
    }
    return { kind: 'network', message: msg };
  }

  return {
    kind: 'bad_response',
    message: input === undefined || input === null ? '空响应' : String(input),
  };
}

/**
 * Pick the single highest-priority error to surface from a collection.
 * Returns `null` for empty / nullish input (UI shows nothing — R14.6).
 *
 * @param {Iterable<ClassifiedLlmError>|null|undefined} errors
 * @returns {ClassifiedLlmError|null}
 */
export function displayedError(errors) {
  if (errors === null || errors === undefined) return null;
  let best = null;
  let bestRank = Infinity;
  for (const e of errors) {
    if (!e || typeof e !== 'object') continue;
    const rank = LLM_ERROR_PRIORITY.indexOf(e.kind);
    if (rank >= 0 && rank < bestRank) {
      best = e;
      bestRank = rank;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Parse a `Retry-After` header value (RFC 7231 §7.1.3): either an integer number
 * of seconds or an HTTP-date. Returns milliseconds, or undefined if absent /
 * unparseable.
 *
 * @param {{get?:(k:string)=>string|null}|undefined} headers
 * @returns {number|undefined}
 */
function parseRetryAfter(headers) {
  if (!headers || typeof headers.get !== 'function') return undefined;
  const raw = headers.get('retry-after');
  if (raw === null || raw === undefined || raw === '') return undefined;

  // Integer seconds form
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }

  // HTTP-date form
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
}
