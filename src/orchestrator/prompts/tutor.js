// Prompt template for Tutor_Agent.
//
// Validates: R13.1 (错误诊断), R13.2 (don't paste full refSql in first
// reply unless user explicitly asks), R13.3 / R13.4 (multi-turn context),
// R13.5 (per-question thread).

const SYSTEM_FIRST = `你是 SQL 错题分析教练。学生提交了错误答案，你需要：
1. 用一句话给出错误分类（语法错误 / 逻辑错误 / 性能问题 / 其他）
2. 用 1-2 句话指出用户 SQL 与正确思路的关键差异
3. 用 1 个引导性问题鼓励学生自己思考

要求：
- 不要直接给出完整参考 SQL（除非学生明确要求）
- 中文回复
- 简洁，避免说教`;

const SYSTEM_FOLLOWUP = `继续作为 SQL 错题分析教练，回答学生的追问。保持简洁，仍然不要直接贴出完整参考 SQL（除非学生明确要求"显示参考答案"）。`;

/**
 * Build the very first diagnostic turn — runs only once per question, right
 * after the Judge returns `verdict.correct === false`.
 *
 * @param {{
 *   question: import('../../types.js').Question,
 *   userSql:  string,
 *   refSql:   string,
 *   diff?:    import('../../types.js').JudgeDiffSummary | import('../../types.js').SqlError | undefined,
 * }} args
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function buildFirstMessage({ question, userSql, refSql, diff }) {
  let diffText = '';
  if (diff && typeof diff === 'object') {
    if ('firstMismatch' in diff && diff.firstMismatch) {
      diffText =
        `首条不匹配：期望 ${JSON.stringify(diff.firstMismatch.expected)}` +
        `，实际 ${JSON.stringify(diff.firstMismatch.actual)}`;
    } else if ('extraRows' in diff || 'missingRows' in diff) {
      diffText = `多出 ${diff.extraRows ?? 0} 行，缺少 ${diff.missingRows ?? 0} 行`;
    } else if ('kind' in diff && 'message' in diff) {
      diffText = `执行错误（${diff.kind}）：${diff.message}`;
    }
  }

  const userContent =
    `题面：${question.prompt}\n\n` +
    `用户 SQL：\n${userSql}\n\n` +
    `（仅供你内部分析使用的参考 SQL）：\n${refSql}\n\n` +
    `结果差异：${diffText || '（无）'}\n\n` +
    `请按格式输出诊断。`;

  return [
    { role: 'system', content: SYSTEM_FIRST },
    { role: 'user',   content: userContent },
  ];
}

/**
 * Build the messages array for a follow-up turn. The full prior thread is
 * spread between system + the new user message — Tutor maintains the
 * complete conversation per question id.
 *
 * @param {{
 *   thread: Array<import('../../types.js').TutorMessage>,
 *   userMessage: string,
 * }} args
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function buildFollowup({ thread, userMessage }) {
  return [
    { role: 'system', content: SYSTEM_FOLLOWUP },
    ...thread.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user',   content: userMessage },
  ];
}
