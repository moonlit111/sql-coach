// AgentState factory and immutable update helpers.
//
// Validates: R14.5 (failure paths only ADD failedAgent/error, never strip
// question/userSql), R17.3 (Partial<state> spread merge — no shared mutable
// references between nodes).
//
// The graph orchestrator (graph.js) imports `mergePartial` to fold each
// node's `Partial<AgentState>` return value back into the global state.
// Failure paths use `withFailure` so the contract from R14.5 is enforced
// at one place rather than scattered across nodes.

/**
 * @typedef {import('../types.js').AgentState}        AgentState
 * @typedef {import('../types.js').LlmConfig}         LlmConfig
 * @typedef {import('../types.js').Theme}             Theme
 * @typedef {import('../types.js').FailedAgentName}   FailedAgentName
 * @typedef {import('../types.js').ClassifiedLlmError} ClassifiedLlmError
 */

/**
 * Build an initial `AgentState` with sane defaults. The session id falls
 * back to a timestamped string so tests don't need to inject one.
 *
 * @param {{
 *   llm?:              LlmConfig,
 *   theme?:            Theme,
 *   themeDescription?: string,
 *   sessionId?:        string,
 * }} [opts]
 * @returns {AgentState}
 */
export function createInitialState(opts = {}) {
  const {
    llm,
    theme = 'ecommerce',
    themeDescription,
    sessionId,
  } = opts;

  const state = /** @type {AgentState} */ ({
    llm: /** @type {LlmConfig} */ (llm ?? {}),
    theme,
    sessionId: sessionId ?? `s-${Date.now()}`,
    history: [],
  });
  if (themeDescription !== undefined) state.themeDescription = themeDescription;
  return state;
}

/**
 * Merge a node's `Partial<AgentState>` return value back into the running
 * state via spread copy. Defensive against `null`/`undefined` returns and
 * non-object payloads. Never mutates the input state.
 *
 * @param {AgentState}  state
 * @param {Partial<AgentState> | null | undefined} partial
 * @returns {AgentState}
 */
export function mergePartial(state, partial) {
  if (partial === null || partial === undefined || typeof partial !== 'object') {
    return state;
  }
  return { ...state, ...partial };
}

/**
 * Mark a specific agent as failed without losing user-visible context.
 * R14.5 — `question`, `userSql`, `userSqlAlt`, `tutorThread`, etc. are
 * preserved verbatim; only `failedAgent` and `error` are added.
 *
 * @param {AgentState} state
 * @param {FailedAgentName} agentName
 * @param {ClassifiedLlmError | string} error
 * @returns {AgentState}
 */
export function withFailure(state, agentName, error) {
  return { ...state, failedAgent: agentName, error };
}

/**
 * Reset the per-question Tutor thread when the user moves to a new question
 * (R13.5). Returns a `Partial<AgentState>` so it can be passed straight to
 * `mergePartial`.
 *
 * @returns {Partial<AgentState>}
 */
export function resetTutorForNewQuestion() {
  return { tutorThread: [] };
}
