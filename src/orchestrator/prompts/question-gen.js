// Prompt template for QuestionGen_Agent.
//
// Validates: R5.3 (Chinese prompt + English SQL), R7.4 (EXCEPT note),
// R8.4 (L3 must include one course-emphasis topic), R8.5 (L4 ≥2 topics),
// R9.1–R9.6 (course emphasis), R19.1–R19.3 (is_ordered consistency).

import { TOPICS, L3_REQUIRED_TOPICS } from '../../data/topics.js';

const SYSTEM = `你是 SQL 题目命题助手。基于用户提供的数据库 schema 生成中文题面与英文 SQL 参考答案。

要求：
- 仅使用 MySQL 兼容子集（避免 IIF/PRINTF/GLOB；用 CASE WHEN）
- 题面用中文写明业务意图，引用英文表名和列名
- 参考 SQL 必须可在该 schema 上执行并返回非空结果（除非题面明确要求空结果）
- L3 难度必须涉及至少一个：相关子查询、EXISTS/NOT EXISTS、全称量词转化(NOT EXISTS)、EXCEPT 差集
- L4 难度必须组合至少 2 个不同知识点
- 当题型为 set_operation_except 时，题面必须同时提到 MySQL 不直接支持 EXCEPT，并给出 NOT IN 或 NOT EXISTS 的等价改写说明
- 当题型为 set_vs_join_compare 时，必须额外输出 refSqlAlt（用另一种写法表达相同语义）
- 仅当题面要求"按 X 排序"或参考 SQL 含 ORDER BY 时，is_ordered = true

输出严格 JSON：
{
  "prompt": "中文题面",
  "refSql": "SQL 文本",
  "refSqlAlt": "（可选）第二种写法",
  "topics": ["..."],
  "is_ordered": true
}

不得包含任何 Markdown 代码块或额外文字。`;

/**
 * @param {{
 *   schemaSummary: import('../../types.js').TableSchema[],
 *   difficulty:    import('../../types.js').DifficultyLevel,
 *   topics:        import('../../types.js').QuestionTopic[],
 *   retryError?:   string,
 * }} args
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function buildPrompt({ schemaSummary, difficulty, topics, retryError }) {
  const schemaText = (schemaSummary ?? []).map((t) => {
    const cols = t.columns.map(
      (c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`
    ).join(', ');
    const pk = t.primaryKey?.length ? ` PRIMARY KEY(${t.primaryKey.join(', ')})` : '';
    return `${t.name}(${cols})${pk}`;
  }).join('\n');

  const topicList = (topics ?? []).map((id) => {
    const t = TOPICS.find((x) => x.id === id);
    return t ? `${id}（${t.zh}）` : id;
  }).join('、');

  const userParts = [
    `数据库 schema：\n${schemaText}`,
    `难度：${difficulty}`,
    `知识点：${topicList || '（未指定）'}`,
  ];
  if (difficulty === 'L3') {
    userParts.push(`注意：L3 题目必须涉及 ${L3_REQUIRED_TOPICS.join(' / ')} 中至少一项。`);
  }
  if (difficulty === 'L4') {
    userParts.push('注意：L4 题目必须组合至少两个不同知识点。');
  }
  if (retryError) {
    userParts.push(`\n上次生成失败原因：${retryError}\n请重新生成。`);
  }
  userParts.push('\n请输出 JSON。');

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user',   content: userParts.join('\n\n') },
  ];
}
