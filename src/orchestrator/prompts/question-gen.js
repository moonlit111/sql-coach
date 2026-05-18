// Prompt template for QuestionGen_Agent.
//
// Validates: R5.3 (Chinese prompt + English SQL), R7.4 (EXCEPT note),
// R8.4 (L3 must include one course-emphasis topic), R8.5 (L4 ≥2 topics),
// R9.1–R9.6 (course emphasis), R19.1–R19.3 (is_ordered consistency).

import { TOPICS, L3_REQUIRED_TOPICS } from '../../data/topics.js';

const SYSTEM = `你是 SQL 题目命题助手。基于用户提供的数据库 schema 生成中文题面与 SQL 参考答案。

要求：
- 仅使用 MySQL 兼容子集（避免 IIF/PRINTF/GLOB；用 CASE WHEN）
- 题面用中文写明业务意图，引用英文表名和列名
- SQL 关键字、表名、列名、运算符、标点必须为英文 ASCII（不要写「，」「；」「（）」「""」「''」等全角字符）
- 字符串字面量内部（'...' 之间）允许中文（用于匹配中文种子数据，如 WHERE name = '张三'）
- **WHERE / HAVING / JOIN ON 中出现的字面量必须严格来自下方「列级元信息」中"枚举值"或"高频前 K"列出的真实值；数值字面量必须落在"范围"区间内**。不要凭印象编造可能不存在的值（如 'VIP_GOLD'、'category_1'、'2030-01-01'）。
- 参考 SQL 必须可在该 schema 上执行并返回非空结果。如果不确定某个过滤条件能匹配到行，宁愿放宽（>/<=/IN(...)）或干脆不加 WHERE。
- **用户指定的"知识点"是硬约束**：参考 SQL 必须真正运用每个指定知识点对应的关键结构。常见映射：
  · join_inner / join_outer / join_self  →  refSql 必须含 JOIN ... ON
  · group_by_having                      →  refSql 必须同时含 GROUP BY 和 HAVING
  · subquery / correlated_subquery       →  refSql 必须含括号内的 SELECT 子查询
  · exists_not_exists / universal_quantifier → refSql 必须含 EXISTS 或 NOT EXISTS
  · set_operation_union / intersect / except → refSql 必须含对应的 UNION / INTERSECT / EXCEPT 关键字
  · order_by_limit                       →  refSql 必须含 ORDER BY
  · set_vs_join_compare                  →  refSql 用集合写法，refSqlAlt 用 JOIN 写法
  topics 字段应至少包含全部用户指定的 ID（你可以追加更多 ID）。若用户指定的知识点与所选难度冲突（如 L3 用户只选了基础知识点），请额外追加一个满足难度规则的知识点到 topics，并让 SQL 同时体现两者。
- L3 难度必须涉及至少一个：相关子查询、EXISTS/NOT EXISTS、全称量词转化(NOT EXISTS)、EXCEPT 差集
- L4 难度必须组合至少 2 个不同知识点
- 当题型为 set_operation_except 时：
  · 题面必须用中文说明 MySQL 不直接支持 EXCEPT，并给出 NOT IN 或 NOT EXISTS 的等价改写说明
  · 但 refSql 字段中**必须**真的使用 EXCEPT 关键字（例如 SELECT ... EXCEPT SELECT ...）
  · 等价的 NOT IN / NOT EXISTS 写法只能写在题面文字里，不要进入 refSql
  · 如果你确实想让 refSql 用 NOT EXISTS（不用 EXCEPT），那么必须保证 NOT EXISTS 真实出现在 refSql 中
- 当题型为 set_vs_join_compare 时，必须额外输出 refSqlAlt（用另一种写法表达相同语义）
- 排序一致性（必须严格遵守，否则会被判错重试）：
  · 若 refSql 含 ORDER BY，则 is_ordered 必须为 true，且题面必须明确写"按 <列> 排序/升序/降序"（推荐写法："按 X 升序排序"或"按 X 降序排序"）
  · 若题面要求排序，则 refSql 必须含 ORDER BY，且 is_ordered 必须为 true
  · 若题面没有任何排序要求且 refSql 没有 ORDER BY，则 is_ordered 必须为 false
  · 三者只要任一不一致就视为错误，不要只在题面里写"展示/列出"却又在 SQL 里加 ORDER BY

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
 *   sampleRows?:   Record<string, Array<Record<string, any>>>,  // tableName → first N rows as objects
 *   columnProfileText?: string,                                  // pre-formatted block from question-gen node's profileSchema
 *   customPrompt?: string,
 * }} args
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function buildPrompt({ schemaSummary, difficulty, topics, retryError, sampleRows, columnProfileText, customPrompt }) {
  const schemaText = (schemaSummary ?? []).map((t) => {
    const cols = t.columns.map(
      (c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`
    ).join(', ');
    const pk = t.primaryKey?.length ? `\n  PRIMARY KEY(${t.primaryKey.join(', ')})` : '';
    const fks = (t.foreignKeys ?? []).map((fk) =>
      `\n  FOREIGN KEY(${fk.columns.join(', ')}) REFERENCES ${fk.refTable}(${fk.refColumns.join(', ')})`
    ).join('');
    return `${t.name}(\n  ${cols}${pk}${fks}\n)`;
  }).join('\n\n');

  // Sample data — gives the LLM concrete row associations (esp. for
  // JOIN-heavy questions where the model needs to see which user_id
  // values appear together with which order_id values).
  const sampleText = sampleRows && Object.keys(sampleRows).length > 0
    ? '\n\n样本数据（每张表前 6 行）：\n' +
      Object.entries(sampleRows).map(([name, rows]) => {
        if (!rows || rows.length === 0) return `${name}: (空)`;
        const lines = rows.slice(0, 6).map((r) => '  ' + JSON.stringify(r));
        return `${name}:\n${lines.join('\n')}`;
      }).join('\n')
    : '';

  // Column profile — already formatted by the node into a compact block.
  // This is the load-bearing addition: gives the model the EXACT set of
  // values it can use in WHERE / HAVING (枚举值), the numeric ranges it
  // should stay within, and the date windows that have data.
  const profileText = columnProfileText ?? '';

  // Custom prompt mode — user provides free-form instructions.
  if (customPrompt && customPrompt.trim()) {
    const userParts = [
      `数据库 schema：\n${schemaText}${profileText}${sampleText}`,
      `用户自定义出题要求：\n${customPrompt.trim()}`,
      `请根据上述要求和数据库 schema 生成一道 SQL 题目。`,
    ];
    if (retryError) {
      userParts.push(`\n上次生成失败原因：${retryError}\n请重新生成。`);
    }
    userParts.push('\n请输出 JSON。');
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user',   content: userParts.join('\n\n') },
    ];
  }

  const topicList = (topics ?? []).map((id) => {
    const t = TOPICS.find((x) => x.id === id);
    return t ? `${id}（${t.zh}）` : id;
  }).join('、');

  const userParts = [
    `数据库 schema：\n${schemaText}${profileText}${sampleText}`,
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
