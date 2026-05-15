// Prompt template for Tutor_Agent (在线问答).
//
// Validates: R13.1 (诊断/问答), R13.2 (don't paste full refSql in first
// reply unless user explicitly asks), R13.3 / R13.4 (multi-turn context),
// R13.5 (per-question thread).
//
// Updated: supports both correct and incorrect answers. When the answer is
// correct the tutor congratulates and offers to discuss optimisation or
// alternative approaches. When wrong, it diagnoses the error as before.

const SYSTEM_FIRST_WRONG = `你是 SQL 在线问答教练。学生提交了错误答案，你需要：
1. 用一句话给出错误分类（语法错误 / 逻辑错误 / 性能问题 / 其他）
2. 用 1-2 句话指出用户 SQL 与正确思路的关键差异
3. 用 1 个引导性问题鼓励学生自己思考

要求：
- 不要直接给出完整参考 SQL（除非学生明确要求）
- 中文回复
- 简洁，避免说教`;

const SYSTEM_FIRST_CORRECT = `你是 SQL 在线问答教练。学生提交了正确答案，你需要：
1. 简短肯定学生的正确解答
2. 如果学生的写法有优化空间（性能、可读性、简洁性），给出 1-2 条建议
3. 如果有其他等价写法（如用 JOIN 替代子查询，或反之），简要提及

要求：
- 中文回复
- 简洁，避免说教
- 如果学生的 SQL 已经很好，就简短表扬即可`;

const SYSTEM_FOLLOWUP = `你是 SQL 在线问答教练。继续回答学生关于当前题目的追问。

当前题目上下文会在下方提供。请基于题目信息回答学生的问题。

要求：
- 不要直接给出完整参考 SQL（除非学生明确要求"显示参考答案"）
- 中文回复
- 简洁`;

/**
 * Build the very first diagnostic/feedback turn — runs once per submission.
 * For wrong answers: diagnoses the error.
 * For correct answers: provides feedback and suggestions.
 *
 * @param {{
 *   question: import('../../types.js').Question,
 *   userSql:  string,
 *   refSql:   string,
 *   correct?: boolean,
 *   diff?:    import('../../types.js').JudgeDiffSummary | import('../../types.js').SqlError | undefined,
 * }} args
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function buildFirstMessage({ question, userSql, refSql, diff, correct }) {
  let diffText = '';
  if (!correct && diff && typeof diff === 'object') {
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

  const systemPrompt = correct ? SYSTEM_FIRST_CORRECT : SYSTEM_FIRST_WRONG;

  let userContent;
  if (correct) {
    userContent =
      `题面：${question.prompt}\n\n` +
      `学生 SQL：\n${userSql}\n\n` +
      `（仅供你内部分析使用的参考 SQL）：\n${refSql}\n\n` +
      `学生答案正确。请给出反馈。`;
  } else {
    userContent =
      `题面：${question.prompt}\n\n` +
      `用户 SQL：\n${userSql}\n\n` +
      `（仅供你内部分析使用的参考 SQL）：\n${refSql}\n\n` +
      `结果差异：${diffText || '（无）'}\n\n` +
      `请按格式输出诊断。`;
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userContent },
  ];
}

/**
 * Build the messages array for a follow-up turn. Includes question context
 * so the LLM always knows what question is being discussed, even if the
 * user starts chatting without a prior firstMessage.
 *
 * @param {{
 *   thread: Array<import('../../types.js').TutorMessage>,
 *   userMessage: string,
 *   question?: import('../../types.js').Question | null,
 *   userSql?: string,
 *   schemaSummary?: Array<{name: string, columns: any[]}> | null,
 *   verdict?: { correct: boolean, diffSummary?: any, sandboxError?: any } | null,
 * }} args
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function buildFollowup({ thread, userMessage, question, userSql, schemaSummary, verdict }) {
  // Build a context block so the model always has the question in view.
  let contextBlock = '';
  if (question) {
    const parts = [
      `题面：${question.prompt}`,
      `知识点：${(question.topics ?? []).join(', ')}`,
      `难度：${question.difficulty ?? '?'}`,
    ];
    if (userSql) parts.push(`学生 SQL：${userSql}`);
    if (question.refSql) parts.push(`参考 SQL（仅供你分析）：${question.refSql}`);
    if (verdict) {
      parts.push(`判题结果：${verdict.correct ? '正确' : '错误'}`);
      if (verdict.diffSummary) {
        parts.push(`差异：缺少 ${verdict.diffSummary.missingRows ?? 0} 行，多出 ${verdict.diffSummary.extraRows ?? 0} 行`);
      }
      if (verdict.sandboxError) {
        parts.push(`执行错误：${verdict.sandboxError.message ?? verdict.sandboxError.kind ?? '未知'}`);
      }
    }
    if (schemaSummary && schemaSummary.length > 0) {
      const schemaLines = schemaSummary.map((t) =>
        `${t.name}(${(t.columns ?? []).map((c) => c.name).join(', ')})`
      ).join('; ');
      parts.push(`数据库表：${schemaLines}`);
    }
    contextBlock = `\n\n---\n当前题目上下文：\n${parts.join('\n')}\n---\n`;
  }

  return [
    { role: 'system', content: SYSTEM_FOLLOWUP + contextBlock },
    ...thread.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user',   content: userMessage },
  ];
}
