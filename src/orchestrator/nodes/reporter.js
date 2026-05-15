// Reporter_Agent node — [OPT] in v1.
//
// Validates: R16.1 (gated on ≥5 answers), R16.2 (per-topic / per-difficulty
// stats), R16.3 (≥1 concrete next-step recommendation in the report body —
// enforced by the prompt template, not by the node).
//
// The reporter now returns a structured object:
//   {
//     report: {
//       stats: { byTopic, byDifficulty, total, correctTotal },  // deterministic
//       summary, scores[], weakTopics[], strengths[], recommendation,  // LLM
//     }
//   }
// If the LLM JSON parse fails, the node still returns the deterministic
// stats with empty AI sections — the UI degrades gracefully.

import { buildPrompt, summariseHistory, parseReport } from '../prompts/reporter.js';
import { vendorExtras } from '../llm-utils.js';

/**
 * @param {{ llmClient: {
 *   chat: (messages: any[], opts?: any) => Promise<{ content: string }>,
 * } }} deps
 */
export function createReporterNode({ llmClient }) {
  /**
   * @param {import('../../types.js').AgentState} state
   */
  return async function reporterNode(state) {
    const history = state.history ?? [];
    if (history.length < 5) {
      // R16.1 — gate strictly on ≥5 answers; surface the failure through
      // the standard `failedAgent` channel so the UI can show one sink.
      return { failedAgent: 'Reporter', error: '至少完成 5 题后才能生成报告' };
    }

    // Deterministic stats — always computed, regardless of LLM outcome.
    const stats = summariseHistory(history);

    let aiSections = {
      summary: '',
      scores: [],
      weakTopics: [],
      strengths: [],
      recommendation: '',
    };
    let rawContent = '';

    try {
      const messages = buildPrompt({ history });
      const extras = vendorExtras(state?.llm?.modelName, 'reason');
      const { content } = await llmClient.chat(messages,
        extras ? { extraBody: extras } : {});
      rawContent = content;
      try {
        aiSections = parseReport(content);
      } catch (parseErr) {
        // LLM produced something that isn't parseable JSON. Keep the raw
        // content around so the UI can show it as a fallback markdown
        // block, but don't fail the whole report — the charts still work.
        aiSections = {
          summary: '',
          scores: [],
          weakTopics: [],
          strengths: [],
          recommendation: '',
          parseError: String(parseErr?.message ?? parseErr),
          rawMarkdown: rawContent,
        };
      }
    } catch (e) {
      return { failedAgent: 'Reporter', error: String(e?.message ?? e?.kind ?? e) };
    }

    return {
      report: {
        generatedAt: Date.now(),
        stats,
        ...aiSections,
      },
    };
  };
}
