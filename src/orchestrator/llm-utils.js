// Small helpers shared by Agent nodes that talk to the LLM in JSON mode.
//
// Why this file:
//   - Different vendors mangle "JSON-mode" output differently: OpenAI is
//     strict; DeepSeek V4 in thinking mode occasionally emits empty content
//     (see https://api-docs.deepseek.com/guides/json_mode);
//     other models like to wrap JSON in ```json fences or prepend prose.
//   - Centralising extraction + vendor extras keeps each Agent node's
//     retry loop focused on validation rather than parsing folklore.

/**
 * Extract a JSON object from a possibly-noisy LLM response.
 *
 * Handles, in order:
 *   1. ```json … ``` and ``` … ``` fenced blocks
 *   2. Bare object that already starts with `{`
 *   3. Prose-wrapped JSON: finds the first balanced `{...}` substring
 *      (string-literal aware so braces inside quotes are ignored)
 *
 * Returns the raw JSON string (still requires JSON.parse), or null when no
 * balanced object is present.
 *
 * @param {unknown} content
 * @returns {string | null}
 */
export function extractJsonObject(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (trimmed === '') return null;

  const fence = /^```(?:json)?\s*\n?([\s\S]*)\n?```\s*$/i.exec(trimmed);
  if (fence) return fence[1].trim();

  if (trimmed.startsWith('{')) return trimmed;

  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Vendor-specific request extras, scoped per task class.
 *
 * SQLense has two task classes:
 *   - `'json'`     SchemaGen / QuestionGen — output strict JSON.
 *                  DeepSeek V4 thinking + JSON mode is unreliable
 *                  (https://api-docs.deepseek.com/guides/json_mode warns
 *                  about empty content). Disable thinking here.
 *   - `'reason'`   Tutor / Reporter — produce free-form Chinese answers
 *                  where chain-of-thought genuinely improves quality.
 *                  Keep thinking enabled for DeepSeek thinking-capable
 *                  models so users still get the reasoning bump.
 *
 * Other vendors get an empty result regardless of task class — only
 * DeepSeek defines the `thinking` parameter at the moment.
 *
 * @param {string | null | undefined} modelName
 * @param {'json' | 'reason'} [task='json']
 * @returns {Record<string, any> | undefined}
 */
export function vendorExtras(modelName, task = 'json') {
  const m = String(modelName ?? '').toLowerCase();
  if (!m.includes('deepseek')) return undefined;
  if (task === 'json') {
    return { thinking: { type: 'disabled' } };
  }
  // task === 'reason' — explicitly enable so non-default deployments
  // (e.g. an upstream proxy that flips the default) still benefit from
  // chain-of-thought on tutor/reporter calls.
  return { thinking: { type: 'enabled' } };
}
