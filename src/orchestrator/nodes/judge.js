// Judge_Agent node.
//
// Thin wrapper around the pure `compare` function (src/judge/compare.js).
// Picks the comparison mode from `question.isOrdered` (R19.4) and, for
// `set_vs_join_compare`, runs both `userSql` and `userSqlAlt` against the
// reference result and AND-combines the verdicts (R12.8).
//
// No LLM call (D4 — judging is deterministic).

import { compare } from '../../judge/compare.js';

/**
 * @param {{ sandbox: {
 *   exec: (sql: string, opts?: any) => Promise<any>,
 * } }} deps
 */
export function createJudgeNode({ sandbox }) {
  /**
   * @param {import('../../types.js').AgentState} state
   * @returns {Promise<Partial<import('../../types.js').AgentState>>}
   */
  return async function judgeNode(state) {
    const q = state.question;
    if (!q) return { failedAgent: 'Judge', error: '缺少 question' };
    if (typeof state.userSql !== 'string') {
      return { failedAgent: 'Judge', error: '缺少 userSql' };
    }

    const mode = q.isOrdered ? 'sequence' : 'multiset';

    const userResult = await sandbox.exec(state.userSql, { allowDml: false });
    let verdict = userResult && userResult.kind
      ? { correct: false, sandboxError: userResult }
      : compare(userResult, q.expectedResult, mode);

    // R12.8 — set_vs_join_compare: BOTH submissions must equal the reference.
    if (q.topics?.includes('set_vs_join_compare')) {
      if (typeof state.userSqlAlt !== 'string') {
        return {
          verdict: { correct: false, diffSummary: { extraRows: 0, missingRows: 0 } },
          userResult,
        };
      }
      const altResult = await sandbox.exec(state.userSqlAlt, { allowDml: false });
      const altVerdict = altResult && altResult.kind
        ? { correct: false, sandboxError: altResult }
        : compare(altResult, q.expectedResult, mode);

      verdict = {
        correct: verdict.correct && altVerdict.correct,
        ...(verdict.diffSummary    ? { diffSummary:  verdict.diffSummary    }
          : altVerdict.diffSummary ? { diffSummary:  altVerdict.diffSummary }
          : {}),
        ...(verdict.sandboxError    ? { sandboxError: verdict.sandboxError    }
          : altVerdict.sandboxError ? { sandboxError: altVerdict.sandboxError }
          : {}),
      };
    }

    return { verdict, userResult };
  };
}
