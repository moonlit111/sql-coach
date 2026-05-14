// LLM Client — OpenAI-compatible Chat Completions wrapper.
//
// Validates: Requirements R1.3, R1.4, R1.6, R2.2, R2.4, R3.3, R4.4, R14.4
// Implements: design.md → "LLM Client" section
//             design.md → Property 2 (outbound request allowlist)
//
// Contract (LlmClient interface from design.md):
//   chat(messages, opts?): Promise<{ content: string, raw: any }>
//   testConnection():       Promise<{ ok, latencyMs, sample?, error? }>
//
// Design notes:
//   - 60 second default timeout via `AbortController` (R3.3, R14.4).
//   - 10 second timeout for the "测试连接" minimal request (R1.6).
//   - The Authorization header is the *only* place the apiKey ever flows;
//     it is added only when the resolved request URL shares the apiBaseUrl
//     origin (Property 2.b). The client refuses to fetch a URL that falls
//     outside that origin (Property 2.a / R4.4 / R10.1).
//   - All error paths route through `classifyError` so the UI sees a
//     `ClassifiedLlmError` shape (Property 4 / R14.6).

import { classifyError } from './errors.js';

/** Default chat() timeout — 60s per R3.3 / R14.4. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** "测试连接" timeout — 10s per R1.6. */
const TEST_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * @typedef {Object} LlmConfig
 * @property {string} apiBaseUrl
 * @property {string} apiKey
 * @property {string} modelName
 */

/**
 * @typedef {Object} ChatMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} ChatOpts
 * @property {number} [timeoutMs]
 * @property {number} [temperature]
 * @property {'text'|'json_object'} [responseFormat]
 * @property {AbortSignal} [signal]
 * @property {number} [maxTokens]
 */

/**
 * Build an LLM client bound to a config. Returns an object with `chat` and
 * `testConnection` methods. Throws if any required config field is missing.
 *
 * @param {Partial<LlmConfig>} config
 */
export function createLlmClient(config) {
  if (
    !config ||
    typeof config.apiBaseUrl !== 'string' || config.apiBaseUrl.trim() === '' ||
    typeof config.apiKey     !== 'string' || config.apiKey.trim()     === '' ||
    typeof config.modelName  !== 'string' || config.modelName.trim()  === ''
  ) {
    throw new Error('createLlmClient: incomplete config');
  }

  // Strip any trailing slash so we don't end up with `//chat/completions`.
  const apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, '');

  // Pre-compute the expected origin once. If apiBaseUrl is malformed, every
  // chat() call will throw the allowlist error below — better to surface that
  // at the call site than crash on URL construction.
  const expectedOrigin = (() => {
    try { return new URL(apiBaseUrl).origin; } catch { return null; }
  })();

  /**
   * Build the Chat Completions URL and verify it falls on `expectedOrigin`.
   * Property 2.a guard.
   * @param {string} path
   */
  function buildUrl(path) {
    if (expectedOrigin === null) {
      throw new Error('llm-client: invalid apiBaseUrl origin');
    }
    const url = `${apiBaseUrl}${path}`;
    let parsedOrigin;
    try {
      parsedOrigin = new URL(url).origin;
    } catch {
      throw new Error('llm-client: invalid request URL');
    }
    if (parsedOrigin !== expectedOrigin) {
      throw new Error(
        'llm-client: refusing to call URL outside configured apiBaseUrl origin',
      );
    }
    return url;
  }

  /**
   * Send one Chat Completions request.
   *
   * @param {ChatMessage[]} messages
   * @param {ChatOpts} [opts]
   * @returns {Promise<{ content: string, raw: any }>}
   */
  async function chat(messages, opts = {}) {
    const url = buildUrl('/chat/completions');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (opts.signal) {
      // Forward an external abort into our controller (and stop the timer).
      const onExternal = () => ctrl.abort();
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener('abort', onExternal, { once: true });
    }

    /** @type {Record<string, any>} */
    const body = {
      model: config.modelName,
      messages,
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    if (typeof opts.maxTokens === 'number') {
      body.max_tokens = opts.maxTokens;
    }

    /** @type {Response | null} */
    let response = null;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Property 2.b — Authorization only on requests to expectedOrigin
          // (already enforced by buildUrl above).
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      // fetch throws on network failure, abort, CORS preflight rejection.
      // classifyError differentiates AbortError (timeout) vs TypeError (CORS).
      throw classifyError(e);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw classifyError(response);
    }

    let json;
    try {
      json = await response.json();
    } catch (_e) {
      throw { kind: 'bad_response', message: 'Failed to parse JSON response' };
    }
    if (json === null || typeof json !== 'object') {
      throw { kind: 'bad_response', message: 'Response body was not a JSON object' };
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw { kind: 'bad_response', message: 'Missing message.content in response' };
    }
    return { content, raw: json };
  }

  /**
   * Minimal request used by the Settings "测试连接" button (R1.6).
   * 10 second AbortController timeout. Returns a structured result instead
   * of throwing — the UI surfaces both branches.
   *
   * @returns {Promise<{ ok: boolean, latencyMs: number, sample?: string, error?: any }>}
   */
  async function testConnection() {
    const start = Date.now();
    try {
      const r = await chat(
        [{ role: 'user', content: 'ping' }],
        { timeoutMs: TEST_CONNECTION_TIMEOUT_MS, maxTokens: 1 },
      );
      return {
        ok: true,
        latencyMs: Date.now() - start,
        sample: typeof r.content === 'string' ? r.content.slice(0, 100) : '',
      };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: e };
    }
  }

  return { chat, testConnection };
}
