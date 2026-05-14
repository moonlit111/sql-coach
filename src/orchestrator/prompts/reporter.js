// Prompt template for Reporter_Agent (R16, [OPT] in v1).
//
// Validates: R16.1 (gated on ≥5 answers), R16.2 (per-topic / per-difficulty
// stats), R16.3 (≥1 concrete next-step recommendation), R16.4 (Markdown
// output friendly for export).

const SYSTEM = `你是 SQL 学习能力分析助手，输出简洁的中文 Markdown 报告。
报告须包含：
- 按知识点的正确率（topic, total, correct, rate）
- 按难度的正确率（L1/L2/L3/L4）
- 薄弱点（按错误率排序前 3 个）
- 至少 1 条具体的下一步学习建议

不要包含任何代码块包围（直接输出 Markdown）；不要使用表情符号。`;

/**
 * @param {{ history: Array<import('../../types.js').AnswerRecord & {
 *   question?: import('../../types.js').Question
 * }> }} args
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function buildPrompt({ history }) {
  const stats = summariseHistory(history);
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        '请基于以下答题统计输出能力报告：\n' +
        JSON.stringify(stats, null, 2),
    },
  ];
}

/**
 * Aggregate per-topic and per-difficulty correctness from a list of
 * answer records (each carrying the originating question reference).
 *
 * @param {Array<any>} history
 */
export function summariseHistory(history) {
  /** @type {Record<string, { total:number, correct:number }>} */
  const byTopic = {};
  /** @type {Record<string, { total:number, correct:number }>} */
  const byDifficulty = {};

  for (const a of history ?? []) {
    const q = a.question ?? {};
    const correct = !!a.verdict?.correct;
    for (const t of q.topics ?? []) {
      if (!byTopic[t]) byTopic[t] = { total: 0, correct: 0 };
      byTopic[t].total += 1;
      if (correct) byTopic[t].correct += 1;
    }
    if (q.difficulty) {
      if (!byDifficulty[q.difficulty]) byDifficulty[q.difficulty] = { total: 0, correct: 0 };
      byDifficulty[q.difficulty].total += 1;
      if (correct) byDifficulty[q.difficulty].correct += 1;
    }
  }

  return { byTopic, byDifficulty, total: (history ?? []).length };
}
