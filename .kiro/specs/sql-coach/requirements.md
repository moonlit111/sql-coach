# Requirements Document

## Introduction

SQL 教练 (SQL Coach) 是一个面向 SQL 学习者的纯前端、浏览器端学习系统，由 LLM Agent 驱动，部署在 GitHub Pages 等静态托管环境，无后端服务。系统通过五个协作的 Agent（SchemaGen / QuestionGen / Judge / Tutor / Reporter）形成"出题—答题—判题—解析答疑—成绩报告"的闭环：用户选定业务主题与难度后，Agent 生成数据库模式与种子数据、按知识点和难度生成 SQL 题目；用户在浏览器内置的 SQLite (sql.js) 沙箱中作答，由 Judge Agent 基于结果集语义等价进行判题；错题由 Tutor Agent 进行诊断与多轮答疑；可选地由 Reporter Agent 输出阶段性能力分析与改进建议。

系统课程对齐重点：单表查询、聚合函数、多表连接、`GROUP BY` + `HAVING`、子查询与相关子查询、`EXISTS` / `NOT EXISTS`、全称量词转化、集合运算（含差集做问题转化）、集合查询与连接查询的对比。LLM 端点用户自配置（OpenAI 兼容协议），密钥仅保存在 `localStorage`，仅发往用户自配置端点。

## Glossary

- **SQL_Coach**: 整个 SQL 教练前端学习系统的对外名称，本规约中作为系统主体。
- **Settings_Module**: 设置模块，负责管理用户配置的 LLM API Base URL、API Key、Model Name 等参数。
- **Agent_Orchestrator**: 基于 LangGraph.js 在浏览器中运行的多 Agent 编排器，调度 SchemaGen / QuestionGen / Judge / Tutor / Reporter 五个 Agent。
- **SchemaGen_Agent**: 模式生成 Agent，按用户选定的业务主题生成 DDL 与种子数据。
- **QuestionGen_Agent**: 题目生成 Agent，按知识点分类与难度生成中文题面、参考 SQL、预期结果集。
- **Judge_Agent**: 判题 Agent，基于结果集语义等价（含有序/无序判定）判定用户 SQL 的正确性。
- **Tutor_Agent**: 错题解析与答疑 Agent，进行错误诊断（语法/逻辑/性能）并支持针对当前题目的多轮问答。
- **Reporter_Agent**: 报告 Agent，依据本次或历史会话记录输出能力分析与改进建议。
- **SQL_Sandbox**: 基于 sql.js（SQLite WASM）的浏览器内 SQL 执行沙箱。
- **MySQL_Compatible_Subset**: 系统在生成 DDL 与参考 SQL 时遵循的、同时在 SQLite 与 MySQL 中合法的 SQL 子集。
- **Difficulty_Level**: 题目难度等级，取值 `L1` / `L2` / `L3` / `L4`，分别对应基础 / 进阶 / 难点 / 综合。
- **Question_Topic**: 题目知识点分类，取值集合包括 `single_table_select`、`where_filter`、`order_by_limit`、`aggregate_function`、`join_inner`、`join_outer`、`join_self`、`group_by_having`、`subquery`、`correlated_subquery`、`exists_not_exists`、`universal_quantifier`、`set_operation_union`、`set_operation_intersect`、`set_operation_except`、`set_vs_join_compare`。
- **Result_Set**: SQL 查询执行后返回的结果集，包含列名序列与行数据序列。
- **Ordered_Question**: 题面或参考 SQL 中包含 `ORDER BY` / `LIMIT` 等顺序敏感语义的题目。
- **Unordered_Question**: 不含顺序敏感语义、按集合（多重集）语义比较的题目。
- **Session**: 一次连续的练习会话，从加载或创建数据库到用户主动结束或刷新页面之间的过程，包含若干题目记录。
- **Answer_Record**: 一道题的作答记录，包含题目、用户 SQL、执行结果、判题结果、解析与答疑历史。
- **Persistence_Store**: 浏览器 `localStorage`，用于保存设置、题库、模式、答题记录。
- **Theme**: 数据库业务主题，例如 `电商` / `校园` / `图书馆` / `医院` / `自定义`。

## Requirements

### Requirement 1: LLM 端点用户自配置

**User Story:** 作为学习者，我希望在系统中配置自己的 LLM API（兼容 OpenAI 协议），以便使用 OpenAI / DeepSeek / 通义千问 / 本地 Ollama / Claude 代理等不同模型驱动 Agent。

#### Acceptance Criteria

1. THE Settings_Module SHALL 提供独立的设置界面，包含 `API Base URL`、`API Key`、`Model Name` 三个文本输入字段。
2. WHEN 用户在设置界面提交配置，THE Settings_Module SHALL 将该配置写入 Persistence_Store，并在后续 Agent 调用中使用该配置。
3. WHEN Agent_Orchestrator 调用 LLM，THE Agent_Orchestrator SHALL 仅向用户当前配置的 `API Base URL` 发起请求，不向其他任何地址发送 `API Key` 或用户数据。
4. THE Agent_Orchestrator SHALL 使用 OpenAI 兼容的 Chat Completions 请求与响应格式与 LLM 端点交互。
5. IF `API Base URL` 或 `API Key` 为空，THEN THE Agent_Orchestrator SHALL 拒绝执行需要 LLM 的操作，并在 UI 中提示用户先在设置中填写完整。
6. WHEN 用户点击设置界面的"测试连接"按钮，THE Settings_Module SHALL 使用当前配置向 LLM 端点发起一次最小化请求，并在 10 秒内向 UI 返回成功或失败结果。
7. THE Settings_Module SHALL 在 UI 中以掩码方式显示 `API Key`，并提供显式"显示"切换按钮以查看明文。

### Requirement 2: 凭据隔离与隐私

**User Story:** 作为学习者，我希望我的 API Key 不被泄露到第三方，以便安全地使用自有额度。

#### Acceptance Criteria

1. THE Settings_Module SHALL 仅将 `API Key` 存储于 Persistence_Store。
2. THE SQL_Coach SHALL 不向除用户已配置的 LLM 端点之外的任何域名发送 `API Key` 或用户作答数据。
3. WHEN 用户在设置界面点击"清除配置"，THE Settings_Module SHALL 从 Persistence_Store 删除 `API Key`、`API Base URL`、`Model Name`。
4. THE SQL_Coach SHALL 不输出 `API Key` 至浏览器控制台日志、远程错误上报渠道或剪贴板（除非用户显式触发复制）。
5. IF 浏览器禁用 `localStorage`，THEN THE Settings_Module SHALL 提示用户当前会话仅在内存中保存配置，刷新页面后将丢失。

### Requirement 3: CORS 与端点可达性

**User Story:** 作为学习者，我希望系统在 LLM 端点不允许跨域时给出明确提示，以便我修正配置。

#### Acceptance Criteria

1. IF 浏览器对 LLM 请求返回 CORS 错误，THEN THE Agent_Orchestrator SHALL 在 UI 中显示包含"CORS"字样的错误提示，并提示用户检查端点的跨域设置。
2. THE Settings_Module SHALL 在设置界面中以静态文案说明：用户配置的 LLM 端点必须允许从当前页面所在源发起的跨域请求。
3. WHEN LLM 请求超过 60 秒未返回，THE Agent_Orchestrator SHALL 中止该请求并向 UI 返回超时错误。

### Requirement 4: 无构建步骤的纯前端部署

**User Story:** 作为开发者/学习者，我希望直接打开 `index.html` 或将仓库托管到 GitHub Pages 即可运行系统，以便无需任何构建工具。

#### Acceptance Criteria

1. THE SQL_Coach SHALL 由原生 HTML 与 ESM 模块化 JavaScript 构成，不依赖任何打包、转译或服务端渲染步骤。
2. WHEN 用户通过浏览器打开 `index.html` 或访问 GitHub Pages 部署 URL，THE SQL_Coach SHALL 在不依赖任何后端服务的情况下完成初始化与渲染。
3. THE SQL_Coach SHALL 通过 ESM 或 CDN 方式加载第三方依赖（包括 LangGraph.js、sql.js）。
4. THE SQL_Coach SHALL 不在运行期向除用户配置的 LLM 端点与依赖 CDN 之外的服务器发起请求。

### Requirement 5: 默认语言与双语策略

**User Story:** 作为中文学习者，我希望题面、提示与 UI 默认显示中文，但 SQL 关键字与 schema 标识符保持英文，以贴近真实开发环境。

#### Acceptance Criteria

1. THE SQL_Coach SHALL 使用中文作为 UI 文案、题面、错题解析与 Tutor_Agent 回复的默认语言。
2. THE SchemaGen_Agent SHALL 使用英文标识符（表名、列名、约束名）生成 DDL 与种子数据。
3. THE QuestionGen_Agent SHALL 在题面正文中使用中文，但保留英文表名、列名与 SQL 关键字。
4. WHEN 用户在 Tutor_Agent 对话中以英文提问，THE Tutor_Agent SHALL 仅针对该次提问的即时回复使用与提问相同的语言，后续回复语言依下一次提问语言独立判定。

### Requirement 6: 数据库模式与种子数据生成

**User Story:** 作为学习者，我希望按主题（电商/校园/图书馆/医院/自定义）一键生成数据库模式与示例数据，以便在贴近真实业务的场景中练习 SQL。

#### Acceptance Criteria

1. THE SQL_Coach SHALL 在主界面提供主题选择，至少包含 `电商`、`校园`、`图书馆`、`医院`、`自定义` 五个选项。
2. WHEN 用户提交主题选择，THE SchemaGen_Agent SHALL 生成至少 3 张相互通过外键关联的表的 DDL，并生成可在 SQL_Sandbox 中直接执行的种子数据 INSERT 语句。
3. THE SchemaGen_Agent SHALL 仅使用 MySQL_Compatible_Subset 中的语法生成 DDL 与种子数据。
4. WHEN SchemaGen_Agent 生成 DDL 与种子数据后，THE SQL_Coach SHALL 在 SQL_Sandbox 中执行这些语句以验证通过；IF 执行失败，THEN THE SchemaGen_Agent SHALL 至多重试 2 次。
5. IF 在 3 次生成后仍执行失败，THEN THE SQL_Coach SHALL 向用户展示失败原因与最近一次的错误信息，并允许用户重试或切换主题。
6. WHEN 用户选择 `自定义` 主题，THE SchemaGen_Agent SHALL 接受用户的中文业务描述输入，并据此生成 DDL 与种子数据。
7. THE SchemaGen_Agent SHALL 为每张表生成至少 5 行种子数据。
8. THE SQL_Coach SHALL 在生成成功后向用户展示当前数据库的表结构（表名、列名、类型、主外键）。

### Requirement 7: MySQL 兼容子集约束

**User Story:** 作为对齐课程的学习者，我希望 Agent 生成的 SQL 在 MySQL 中也合法，以便在课堂参考实现中通用。

#### Acceptance Criteria

1. THE SchemaGen_Agent SHALL 不在生成的 DDL 中使用仅 SQLite 支持的语法（包括但不限于 `WITHOUT ROWID`、`AUTOINCREMENT` 关键字、`PRAGMA` 语句、动态类型列）。
2. THE QuestionGen_Agent SHALL 不在参考 SQL 中使用仅 SQLite 支持的函数（包括但不限于 `IIF`、`PRINTF`、`GLOB`）。
3. THE SQL_Coach SHALL 在用户文档中明确标注 `MySQL_Compatible_Subset` 的范围与已知不兼容点。
4. WHERE 题目涉及集合运算 `EXCEPT`，THE QuestionGen_Agent SHALL 在题面中说明 MySQL 实际不直接支持 `EXCEPT`，并提供等价的 `NOT IN` 或 `NOT EXISTS` 写法作为替代参考。

### Requirement 8: 题目生成的知识点与难度覆盖

**User Story:** 作为学习者，我希望能按知识点和难度等级抽题，以便针对薄弱点训练。

#### Acceptance Criteria

1. THE SQL_Coach SHALL 在出题界面提供 Difficulty_Level（`L1` / `L2` / `L3` / `L4`）与 Question_Topic 多选过滤。
2. THE QuestionGen_Agent SHALL 至少支持 Glossary 中列出的全部 Question_Topic 类别。
3. WHEN 用户提交难度与知识点选择，THE QuestionGen_Agent SHALL 生成一道题目，包含中文题面、英文标识符的参考 SQL、可在 SQL_Sandbox 中执行得到的预期 Result_Set，以及该题所属的 Difficulty_Level 与 Question_Topic 标签。
4. WHERE 用户选择 Difficulty_Level 为 `L3`，THE QuestionGen_Agent SHALL 优先生成涉及 `correlated_subquery`、`exists_not_exists`、`universal_quantifier`、`set_operation_except` 中至少一个知识点的题目。
5. WHERE 用户选择 Difficulty_Level 为 `L4`，THE QuestionGen_Agent SHALL 在题目中至少组合 2 个不同的 Question_Topic。
6. THE QuestionGen_Agent SHALL 保证生成的参考 SQL 在当前 SQL_Sandbox 的数据库实例上可成功执行并产生 Result_Set。
7. WHEN 参考 SQL 在 SQL_Sandbox 中执行失败或结果为空且题面预期非空，THE QuestionGen_Agent SHALL 至多重试 2 次重新生成该题。
8. IF 重试次数达到上限（共 3 次生成尝试）仍无法产生有效题目，THEN THE SQL_Coach SHALL 立即终止重试，向用户展示失败原因并允许更换知识点或难度。

### Requirement 9: 课程重点知识点的题型支持

**User Story:** 作为对齐课程的学习者，我希望系统对老师强调的难点（分组聚集、相关子查询、EXISTS/NOT EXISTS、全称量词、差集做问题转化、集合查询 vs 连接查询对比）有专门的题型。

#### Acceptance Criteria

1. WHEN 用户选择 `group_by_having` 题型，THE QuestionGen_Agent SHALL 生成题目并产出在参考 SQL 中体现 `GROUP BY` 与 `HAVING` 联合使用的内容。
2. WHEN 用户选择 `correlated_subquery` 题型，THE QuestionGen_Agent SHALL 生成题目并产出包含至少一个引用外层查询列的相关子查询的参考 SQL。
3. WHEN 用户选择 `exists_not_exists` 题型，THE QuestionGen_Agent SHALL 生成题目并产出使用 `EXISTS` 或 `NOT EXISTS` 的参考 SQL。
4. WHEN 用户选择 `universal_quantifier` 题型，THE QuestionGen_Agent SHALL 生成题目并产出将"对所有 X 都成立"翻译为 `NOT EXISTS` 模式的参考 SQL。
5. THE QuestionGen_Agent SHALL 支持 `set_operation_except` 题型，提供基于差集运算进行问题转化的题面与参考 SQL。
6. THE QuestionGen_Agent SHALL 支持 `set_vs_join_compare` 题型：题目要求同一个语义同时给出"集合查询写法"与"连接查询写法"两个参考 SQL，且二者结果集语义等价。

### Requirement 10: SQL 沙箱执行

**User Story:** 作为学习者，我希望在浏览器中安全地执行我的 SQL 查询，以便即时看到结果。

#### Acceptance Criteria

1. THE SQL_Sandbox SHALL 基于 sql.js 在浏览器中执行用户提交的 SQL，不向后端发送用户 SQL。
2. WHEN 用户提交 SQL，THE SQL_Sandbox SHALL 在 5 秒内返回执行结果或超时错误。
3. WHEN 用户 SQL 执行成功，THE SQL_Sandbox SHALL 向 UI 返回 Result_Set，包含列名序列与全部行数据。
4. WHEN 用户 SQL 执行失败，THE SQL_Sandbox SHALL 向 UI 返回错误类型与错误消息文本。
5. THE SQL_Sandbox SHALL 限制单次查询返回的行数不超过 10000 行，超出部分截断并在 UI 中提示。
6. WHEN 用户重置当前题目，THE SQL_Sandbox SHALL 将数据库实例还原为题目初始的种子数据状态。

### Requirement 11: 用户输入 SQL 的安全限制

**User Story:** 作为学习者，我希望系统避免我误执行破坏性 SQL，以便不破坏当前练习数据库。

#### Acceptance Criteria

1. WHEN 用户提交的 SQL 中包含 `DROP`、`ALTER`、`TRUNCATE`、`ATTACH`、`DETACH` 等结构性变更语句，THE SQL_Sandbox SHALL 拒绝执行并向 UI 返回拒绝原因。
2. WHERE 当前题目的 Question_Topic 不属于数据修改类，THE SQL_Sandbox SHALL 拒绝执行 `INSERT` / `UPDATE` / `DELETE` 语句并向 UI 返回拒绝原因。
3. WHEN 用户提交的 SQL 单次执行时间超过 5 秒，THE SQL_Sandbox SHALL 中止执行并向 UI 返回超时错误。
4. THE SQL_Sandbox SHALL 在每次执行用户 SQL 前后保留对当前题目种子数据快照的访问能力，以便按需重置。

### Requirement 12: 判题结果集等价语义

**User Story:** 作为学习者，我希望系统按"结果集等价"判题，而不是逐字比对 SQL，以便不同写法只要结果一致都算对。

#### Acceptance Criteria

1. WHEN 用户提交 SQL 并执行成功，THE Judge_Agent SHALL 比较用户 Result_Set 与参考 Result_Set 的列数与每列数据的语义等价。
2. WHERE 题目为 Unordered_Question，THE Judge_Agent SHALL 按多重集（multiset）语义比较行数据，忽略行的输出顺序。
3. WHERE 题目为 Ordered_Question，THE Judge_Agent SHALL 按序列语义比较行数据，行的输出顺序必须一致。
4. THE Judge_Agent SHALL 不要求用户 Result_Set 的列名与参考 Result_Set 的列名相同，但 SHALL 要求列数相同且对应位置的列值类型可比较。
5. WHEN 用户 Result_Set 与参考 Result_Set 等价，THE Judge_Agent SHALL 返回判定为"正确"。
6. WHEN 用户 Result_Set 与参考 Result_Set 不等价，THE Judge_Agent SHALL 返回判定为"错误"，并附带差异摘要（多余行数、缺失行数、首条差异行）。
7. WHEN 用户 SQL 执行失败，THE Judge_Agent SHALL 返回判定为"错误"，并附带 SQL_Sandbox 的错误消息。
8. WHEN 题目类型为 `set_vs_join_compare`，THE Judge_Agent SHALL 同时校验用户提交的"集合查询写法"与"连接查询写法"两段 SQL 各自结果与参考结果等价。

### Requirement 13: 错题解析与多轮答疑

**User Story:** 作为学习者，我希望在做错题目时获得错误诊断与可追问的讲解，以便理解自己的错误。

#### Acceptance Criteria

1. WHEN Judge_Agent 返回"错误"，THE Tutor_Agent SHALL 自动生成首条错题解析，包含错误类型分类（语法 / 逻辑 / 性能 / 其他）与中文解释。
2. THE Tutor_Agent SHALL 在解析中引用用户提交的 SQL 与参考 SQL 的关键差异，但 SHALL 不直接以原文一次性给出完整参考 SQL（除非用户显式请求"显示参考答案"）。
3. WHEN 用户在错题界面发起追问，THE Tutor_Agent SHALL 基于当前题目上下文（题面、用户 SQL、参考 SQL、Result_Set 差异）进行回答。
4. THE Tutor_Agent SHALL 支持同一道错题下至少 10 轮连续问答，并保留该题的对话上下文。
5. WHEN 用户切换到下一道题，THE Tutor_Agent SHALL 不将上一题的对话上下文带入新题。
6. WHEN 用户显式点击"显示参考答案"按钮，THE Tutor_Agent SHALL 展示该题的完整参考 SQL。

### Requirement 14: LLM 调用失败的优雅降级

**User Story:** 作为学习者，我希望在 LLM 端点不可用时仍能看到清晰的错误提示和重试入口，以便不被卡住。

#### Acceptance Criteria

1. IF LLM 端点返回 401 或 403，THEN THE Agent_Orchestrator SHALL 提示用户 API Key 无效或无权限，并提供跳转到设置界面的入口（不提供原地重试按钮）。
2. IF LLM 端点返回 429，THEN THE Agent_Orchestrator SHALL 提示用户当前被限流，并提供"稍后重试"按钮。
3. IF LLM 端点返回 5xx，THEN THE Agent_Orchestrator SHALL 提示用户服务端错误，并提供"重试"按钮。
4. IF LLM 请求超时（60 秒未返回），THEN THE Agent_Orchestrator SHALL 中止请求并提示超时，附带"重试"按钮。
5. WHEN Agent 调用失败，THE SQL_Coach SHALL 保留当前题目与用户已输入的 SQL 不被清空。
6. WHEN 多种错误条件被触发，THE Agent_Orchestrator SHALL 仅展示与当前最具体错误条件对应的单一提示，不同时显示多个错误提示。

### Requirement 15: 题目与作答的本地持久化

**User Story:** 作为学习者，我希望我的练习记录在刷新页面后仍然存在，以便后续回顾。

#### Acceptance Criteria

1. THE SQL_Coach SHALL 将每道生成的题目（题面、参考 SQL、预期 Result_Set、Difficulty_Level、Question_Topic）写入 Persistence_Store。
2. THE SQL_Coach SHALL 将每条 Answer_Record（题目引用、用户 SQL、用户 Result_Set 摘要、判题结果、Tutor 对话历史）写入 Persistence_Store。
3. WHEN 用户重新打开页面，THE SQL_Coach SHALL 从 Persistence_Store 恢复设置、最近一次的数据库模式与题库列表。
4. THE SQL_Coach SHALL 在历史界面中按时间倒序展示既往 Answer_Record，并允许用户过滤错题；WHEN 过滤结果为空，THE SQL_Coach SHALL 展示空状态视图并显示"没有符合条件的错题"提示。
5. WHEN 用户点击"清空历史"，THE SQL_Coach SHALL 删除 Persistence_Store 中所有 Answer_Record，但不删除 Settings_Module 中的配置。
6. IF Persistence_Store 实际写入失败（例如配额耗尽），THEN THE SQL_Coach SHALL 在 UI 中提示用户保存失败并允许导出当前数据为 JSON；WHEN 写入成功，THE SQL_Coach SHALL 不展示该失败提示与导出选项。

### Requirement 16: 阶段性能力报告（可选）

**User Story:** 作为学习者，我希望在一段练习后得到能力分析与改进建议，以便规划下一步学习。

#### Acceptance Criteria

1. WHERE 用户已完成至少 5 道题，THE SQL_Coach SHALL 在 UI 中开放"生成报告"入口。
2. WHEN 用户点击"生成报告"，THE Reporter_Agent SHALL 基于当前 Session 的 Answer_Record 生成中文报告，包含：按 Question_Topic 维度的正确率、按 Difficulty_Level 维度的正确率、薄弱知识点列表、改进建议。
3. THE Reporter_Agent SHALL 在报告中至少给出 1 条具体的下一步练习建议（建议的 Question_Topic 与 Difficulty_Level 组合）。
4. WHEN 报告生成完成，THE SQL_Coach SHALL 允许用户将报告导出为 Markdown 文件。

### Requirement 17: Agent 编排架构

**User Story:** 作为系统维护者，我希望多 Agent 通过 LangGraph.js 在浏览器中协作，以便有清晰的职责划分与可扩展性。

#### Acceptance Criteria

1. THE Agent_Orchestrator SHALL 基于 LangGraph.js 实现 SchemaGen_Agent、QuestionGen_Agent、Judge_Agent、Tutor_Agent、Reporter_Agent 五个节点的图编排。
2. THE Agent_Orchestrator SHALL 在浏览器主线程或 Web Worker 中运行，不依赖任何后端服务。
3. THE Agent_Orchestrator SHALL 在每个 Agent 节点的输入与输出处使用结构化对象（包含明确的字段名与类型契约）传递数据。
4. WHEN 任意一个 Agent 节点抛出异常，THE Agent_Orchestrator SHALL 中止当前流程并向 UI 返回包含失败 Agent 名称的错误信息。

### Requirement 18: SQL 解析、格式化与往返一致性

**User Story:** 作为学习者，我希望系统能识别我的 SQL 结构、做必要的安全检查与格式化，以便提示更精准。

#### Acceptance Criteria

1. THE SQL_Coach SHALL 提供一个 SQL 解析器，将用户提交的 SQL 解析为抽象语法结构，至少能识别语句类型（`SELECT` / `INSERT` / `UPDATE` / `DELETE` / `DDL` / `OTHER`）与是否包含 `ORDER BY` 子句。
2. THE SQL_Coach SHALL 提供一个 SQL 格式化器（Pretty Printer），将抽象语法结构格式化回带换行与缩进的 SQL 文本。
3. WHEN 用户点击"格式化 SQL"按钮，THE SQL_Coach SHALL 使用 SQL 格式化器替换编辑器中的当前 SQL 文本。
4. FOR ALL 由 QuestionGen_Agent 生成的合法参考 SQL，"解析 → 格式化 → 解析"产生的抽象语法结构 SHALL 与初次解析结果在语义结构上等价（往返属性）。
5. IF 用户提交的 SQL 无法被 SQL 解析器解析，THEN THE SQL_Coach SHALL 不阻止其交由 SQL_Sandbox 执行，但 SHALL 在 UI 中提示无法判定语句类型。

### Requirement 19: 题目顺序敏感性识别

**User Story:** 作为学习者，我希望系统能区分"必须按指定顺序输出"与"任意顺序"两类题目，以便判题不冤枉我。

#### Acceptance Criteria

1. THE QuestionGen_Agent SHALL 为每道生成的题目附带 `is_ordered` 布尔标签。
2. WHERE 题目参考 SQL 中包含 `ORDER BY` 子句或题面明确要求"按 X 排序"，THE QuestionGen_Agent SHALL 将该题标记为 Ordered_Question（`is_ordered = true`）。
3. WHERE 题目参考 SQL 中不包含 `ORDER BY` 子句且题面未要求排序，THE QuestionGen_Agent SHALL 将该题标记为 Unordered_Question（`is_ordered = false`）。
4. THE Judge_Agent SHALL 依据 `is_ordered` 标签选择 Requirement 12 中的有序或无序比较策略。
