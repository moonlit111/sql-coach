// Prompt template for SchemaGen_Agent.
//
// Validates: R5.2 (English identifiers), R6.2 (≥3 tables, ≥1 FK, ≥5 rows
// per table), R6.3 (theme alignment), R6.6 (custom-theme description),
// R7.1 / R7.2 (MySQL-compatible subset).

const THEME_HINTS = {
  ecommerce: '电商：用户、订单、商品、订单明细等业务实体',
  campus:    '校园：学生、课程、选课、教师、成绩等业务实体',
  library:   '图书馆：图书、读者、借阅记录、作者等业务实体',
  hospital:  '医院：医生、患者、就诊、处方等业务实体',
  custom:    '由用户自定义业务（请使用下方"用户描述"）',
};

const SYSTEM = `你是 SQL 数据库设计助手。生成 MySQL 兼容的 DDL 与种子数据。

约束：
- DDL 仅可使用：CREATE TABLE、PRIMARY KEY、FOREIGN KEY ... REFERENCES、UNIQUE、NOT NULL、DEFAULT
- 类型仅可使用：INT/INTEGER、BIGINT、DECIMAL(p,s)、VARCHAR(n)、CHAR(n)、TEXT、DATE、DATETIME
- 禁止：WITHOUT ROWID、AUTOINCREMENT 关键字（用 INTEGER PRIMARY KEY 实现自增）、PRAGMA、CHECK 约束
- 禁止使用 SQL 保留字作为表名或列名，包括但不限于：user、order、group、from、select、where、table、index、key、primary、unique、references、null、default、check、constraint、column、view、trigger
  · 请改用：users、orders、user_groups、… 这类复数或加前缀的命名
- 标识符全部使用英文蛇形命名（snake_case）
- 必须包含至少 3 张通过外键关联的表
- **每张表至少插入 15 行示例数据**（行数充足才能让后续生成的练习题不会因 WHERE/HAVING 过滤而落空；若题目侧出错频繁，行数偏少是常见原因）
- 数据要有适度多样性：枚举字段（如状态、类型、分类）至少覆盖 3 种不同取值；数值字段应有大有小覆盖范围；外键字段必须确实指向已插入的父行
- 禁止在 INSERT 中使用函数（如 CURRENT_TIMESTAMP、NOW()），日期时间请使用形如 '2024-01-15 10:00:00' 的字符串字面量
- DEFAULT 值仅可使用字面量（数字/字符串），禁止 CURRENT_TIMESTAMP

输出严格 JSON：{"ddl": "...", "seedSql": "..."}
- 不得包含任何注释或额外文字
- 不要在 JSON 外面包裹 Markdown 代码块`;

/**
 * @param {{
 *   theme: import('../../types.js').Theme,
 *   themeDescription?: string,
 *   retryError?: string,
 * }} args
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function buildPrompt({ theme, themeDescription, retryError }) {
  const hint = THEME_HINTS[theme] ?? String(theme);
  const userParts = [`主题：${hint}`];
  if (themeDescription) userParts.push(`用户描述：${themeDescription}`);
  if (retryError) userParts.push(`\n上一次生成失败的原因：${retryError}\n请修正后重新生成。`);
  userParts.push('\n请输出 JSON。');

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user',   content: userParts.join('\n') },
  ];
}
