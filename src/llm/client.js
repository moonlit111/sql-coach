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
 * @property {Record<string, any>} [extraBody]   Vendor-specific fields merged into the JSON body
 *                                               (e.g. DeepSeek thinking toggle: { thinking: { type: 'disabled' } }).
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
    // Vendor-specific extras. For DeepSeek V4 series, the orchestrator passes
    // `{ thinking: { type: 'disabled' } }` so JSON-mode prompts don't get
    // mangled by reasoning_content / empty-content edge cases.
    if (opts.extraBody && typeof opts.extraBody === 'object') {
      Object.assign(body, opts.extraBody);
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

    const message = json?.choices?.[0]?.message;
    let content = message?.content;
    // Some vendors (notably DeepSeek V4 thinking mode) may emit reasoning into
    // `reasoning_content` and leave `content` empty when the model stops mid-CoT.
    // Surface this clearly so the orchestrator can retry or so the user can
    // disable thinking mode.
    if (typeof content === 'string' && content.trim() === '' &&
        typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0) {
      throw {
        kind: 'bad_response',
        message:
          '模型只返回了思考内容（reasoning_content），没有最终答案。' +
          'DeepSeek V4 系列在 thinking + JSON 模式下偶发空 content，' +
          '建议改用 deepseek-v4-flash 并关闭 thinking。',
      };
    }
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
   * Strategy: ask the model to return a tiny JSON object so we exercise the
   * full pipeline that real Agents use (JSON mode + non-empty content). For
   * vendors that have to opt out of reasoning to make JSON mode reliable
   * (DeepSeek V4 series), the corresponding extras are passed automatically.
   *
   * @returns {Promise<{ ok: boolean, latencyMs: number, sample?: string, error?: any }>}
   */
  async function testConnection() {
    const start = Date.now();
    // Inline lookup — keep client.js free of orchestrator imports.
    const m = String(config.modelName).toLowerCase();
    const extras = m.includes('deepseek')
      ? { thinking: { type: 'disabled' } }
      : undefined;
    try {
      const r = await chat(
        [
          { role: 'system', content: 'Reply ONLY with the JSON {"ok":true}. Nothing else.' },
          { role: 'user',   content: 'Return JSON {"ok":true}.' },
        ],
        {
          timeoutMs: TEST_CONNECTION_TIMEOUT_MS,
          maxTokens: 32,
          responseFormat: 'json_object',
          ...(extras ? { extraBody: extras } : {}),
        },
      );
      const sample = typeof r.content === 'string' ? r.content.slice(0, 100) : '';
      // The minimum bar is non-empty content; the LLM may pad with whitespace
      // but we don't require strict JSON here so models without a JSON mode
      // still pass when their plain reply is sane.
      if (sample.trim() === '') {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          error: {
            kind: 'bad_response',
            message: '模型返回空内容（可能是 thinking + JSON 模式冲突）',
          },
        };
      }
      return { ok: true, latencyMs: Date.now() - start, sample };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: e };
    }
  }

  return { chat, testConnection };
}
