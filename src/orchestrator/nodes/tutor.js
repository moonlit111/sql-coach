// Tutor_Agent node.
//
// Validates: R13.1 (诊断), R13.2 (no full refSql in first reply),
// R13.3 (multi-turn context), R13.4 (≥10 turns supported), R13.5 (per-
// question thread; switching question resets it).
//
// Unlike the other nodes, Tutor exposes three callables:
//   - firstMessage(state)               — runs once per question after Judge
//   - followup(state, userMessage)      — subsequent user turns
//   - resetForNewQuestion()             — clears tutorThread (R13.5)
//
// These are NOT LangGraph node fns by themselves; the graph orchestrator
// dispatches by sub-action name.

import { tutorPrompt } from '../prompts/index.js';

/**
 * Maximum number of *turns* (each turn = 1 user msg + 1 assistant reply) we
 * will append to a single question's thread. R13.4 demands ≥10. We cap at
 * a higher value so the spec's lower bound is comfortably met without
 * letting a runaway thread blow the localStorage budget.
 */
const MAX_TURNS = 12;

/**
 * @param {{ llmClient: {
 *   chat: (messages: any[], opts?: any) => Promise<{ content: string }>,
 * } }} deps
 */
export function createTutorNode({ llmClient }) {
  return {
    /**
     * Initial diagnostic — only invoked when `verdict.correct === false`.
     * Appends one assistant message to `state.tutorThread`.
     *
     * @param {import('../../types.js').AgentState} state
     * @returns {Promise<Partial<import('../../types.js').AgentState>>}
     */
    async firstMessage(state) {
      if (!state.question) {
        return { failedAgent: 'Tutor', error: '缺少 question' };
      }
      try {
        const messages = tutorPrompt.buildFirstMessage({
          question: state.question,
          userSql:  state.userSql ?? '',
          refSql:   state.question.refSql,
          diff:     state.verdict?.diffSummary ?? state.verdict?.sandboxError,
        });
        const { content } = await llmClient.chat(messages);
        const thread = [
          ...(state.tutorThread ?? []),
          { role: 'assistant', content, at: Date.now() },
        ];
        return { tutorThread: thread };
      } catch (e) {
        return { failedAgent: 'Tutor', error: String(e?.message ?? e?.kind ?? e) };
      }
    },

    /**
     * Follow-up turn. Appends user message → calls LLM with full thread →
     * appends assistant reply.
     *
     * @param {import('../../types.js').AgentState} state
     * @param {string} userMessage
     * @returns {Promise<Partial<import('../../types.js').AgentState>>}
     */
    async followup(state, userMessage) {
      const prior = state.tutorThread ?? [];
      // Each turn = 2 messages (user + assistant) so divide by 2 to count
      // turns. R13.4 — must support ≥10; we cap at MAX_TURNS = 12.
      if (prior.length >= MAX_TURNS * 2) {
        return { error: '已达单题最大对话轮数' };
      }
      const userMsg = { role: /** @type {'user'} */ ('user'), content: userMessage, at: Date.now() };
      const withUser = [...prior, userMsg];
      try {
        const messages = tutorPrompt.buildFollowup({
          thread: prior,
          userMessage,
        });
        const { content } = await llmClient.chat(messages);
        return {
          tutorThread: [
            ...withUser,
            { role: 'assistant', content, at: Date.now() },
          ],
        };
      } catch (e) {
        return { failedAgent: 'Tutor', error: String(e?.message ?? e?.kind ?? e) };
      }
    },

    /**
     * Reset the thread when switching to a new question (R13.5). Returns a
     * `Partial<AgentState>` so it can be mergePartial'd directly.
     *
     * @returns {Partial<import('../../types.js').AgentState>}
     */
    resetForNewQuestion() {
      return { tutorThread: [] };
    },
  };
}
