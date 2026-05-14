// Reporter_Agent node — [OPT] in v1.
//
// Validates: R16.1 (gated on ≥5 answers), R16.2 (per-topic / per-difficulty
// stats), R16.3 (≥1 concrete next-step recommendation in the report body —
// enforced by the prompt template, not by the node).

import { reporterPrompt } from '../prompts/index.js';

/**
 * @param {{ llmClient: {
 *   chat: (messages: any[], opts?: any) => Promise<{ content: string }>,
 * } }} deps
 */
export function createReporterNode({ llmClient }) {
  /**
   * @param {import('../../types.js').AgentState} state
   * @returns {Promise<Partial<import('../../types.js').AgentState> & { report?: string }>}
   */
  return async function reporterNode(state) {
    const history = state.history ?? [];
    if (history.length < 5) {
      // R16.1 — gate strictly on ≥5 answers; surface the failure through
      // the standard `failedAgent` channel so the UI can show one sink.
      return { failedAgent: 'Reporter', error: '至少完成 5 题后才能生成报告' };
    }
    try {
      const messages = reporterPrompt.buildPrompt({ history });
      const { content } = await llmClient.chat(messages);
      return { report: content };
    } catch (e) {
      return { failedAgent: 'Reporter', error: String(e?.message ?? e?.kind ?? e) };
    }
  };
}
