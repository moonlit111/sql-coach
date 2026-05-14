# SQL 教练 演示 PPT 骨架

> 每个 `##` 二级标题 = 一张幻灯片。可直接用 [Marp](https://marp.app/) / [Slidev](https://sli.dev/) 转 PPTX/PDF，或手动迁移到 PowerPoint。

---

## 1. 项目背景与目标

- **问题**：SQL 学习资源散乱，缺少即时反馈；课堂练习靠老师批改、效率低
- **目标**：基于 LLM Agent 的纯前端 SQL 闭环学习系统
- **课程对齐**：MySQL 教学，重点覆盖第二三章（关系代数 + SQL）
- **交付**：一个静态网站 + 一份技术报告

---

## 2. 核心闭环

```
出题 → 答题 → 判题 → 解析答疑 → 报告
```

**5 个 Agent 协作**：
- SchemaGen — 生成数据库
- QuestionGen — 生成题目
- Judge — 判题
- Tutor — 答疑
- Reporter — 出报告

---

## 3. 技术架构

- **纯前端**：原生 HTML + ESM JavaScript，**无构建步骤**
- **自实现轻量编排器**：节点接口与 LangGraph.js 兼容
- **SQL 引擎**：sql.js (SQLite WASM)，约束在 MySQL 兼容子集
- **LLM**：用户自配（OpenAI 兼容协议），仅存 localStorage
- **部署**：GitHub Pages 一键部署

详见 `docs/architecture.md`。

---

## 4. 关键设计决策

| 决策 | 理由 |
|---|---|
| 判题用**纯函数**（不调 LLM） | 结果集等价是确定性比较；稳定、零成本、可 PBT 验证 |
| Sandbox 用 **Web Worker** | 真硬 5 秒超时（terminate）；不阻塞主线程 |
| API Key **仅存 localStorage** | 不发往任何第三方 |
| 解析器**手写** ~300 行 | 避免 18MB 外部依赖；只需识别语句类型与标志位 |
| 沙箱重置用**字节快照** | sql.js export() / new Database(bytes)，O(1) 还原 |

---

## 5. Agent 详解：SchemaGen

**职责**：按业务主题生成 DDL + 种子数据

**主题**：电商 / 校园 / 图书馆 / 医院 / 自定义

**强约束**：
- ≥3 张表，至少 1 个外键
- 每表至少 5 行数据
- 仅用 MySQL 兼容子集（禁 AUTOINCREMENT/WITHOUT ROWID/PRAGMA）

**容错**：3 次重试，每次把上一轮错误回灌给 LLM

---

## 6. Agent 详解：QuestionGen

**职责**：按难度/知识点出题

**16 个知识点 × 4 个难度**：
- L1 基础：单表 SELECT、WHERE、ORDER BY
- L2 进阶：多表 JOIN、聚合、GROUP BY
- L3 难点：子查询、EXISTS、全称量词、差集
- L4 综合：组合 2+ 知识点

**后置校验**：
- L3 必含课程难点
- L4 必组合 ≥2 知识点
- is_ordered 与 ORDER BY 一致
- 参考 SQL 在沙箱中可执行且非空

---

## 7. Agent 详解：Judge

**职责**：判定用户 SQL 是否正确

**算法**：结果集等价（不比较 SQL 文本）
- 题目无 ORDER BY → multiset（多重集）语义
- 题目有 ORDER BY → sequence（序列）语义

**列名宽容**：不要求列名相同

**数值规范化**：`12 == "12" == 12.0`；`null != ''`

**set_vs_join_compare**：双段写法都正确才整体正确

---

## 8. Agent 详解：Tutor

**职责**：错题诊断 + 多轮答疑

**首条诊断**：
1. 错误分类（语法 / 逻辑 / 性能）
2. 用户 SQL 与正确思路的关键差异
3. 引导性问题（不直接给参考 SQL）

**多轮上下文**：
- ≥10 轮对话
- 切换题目时**自动清空**上下文（不让 q1 信息泄漏到 q2）

**显示参考答案**：用户显式点击按钮才显示

---

## 9. Agent 详解：Reporter（可选）

**职责**：阶段性能力分析（≥5 题后开放）

**报告内容**：
- 按知识点维度的正确率
- 按难度维度的正确率
- 薄弱知识点 Top 3
- 至少 1 条具体的下一步练习建议

**导出**：Markdown 文件下载

---

## 10. 课程难点覆盖

| 难点 | 系统支持 |
|---|---|
| GROUP BY + HAVING | `group_by_having` 题型 |
| 相关子查询 | `correlated_subquery` 题型 |
| EXISTS / NOT EXISTS | `exists_not_exists` 题型 |
| 全称量词转化 | `universal_quantifier` 题型（NOT EXISTS 模式） |
| 差集运算 | `set_operation_except` 题型（题面附 MySQL 改写注释） |
| 集合 vs 连接对比 | `set_vs_join_compare` 题型（双段提交） |

L3 难度自动分发上述前 4 个难点之一。

---

## 11. 测试策略

**Property-Based Testing** (fast-check)：

| Property | 验证内容 |
|---|---|
| P1 | SQL 解析-格式化-解析往返一致性 |
| P2 | 出站请求白名单（API Key 不外泄） |
| P3 | 凭据持久化往返与清除 |
| P4 | LLM 错误分类与优先级 |
| P5 | 沙箱重置幂等 |
| P6 | 安全过滤精确性 |
| P7 | 结果集等价比较 |
| P8 | 题目难度/题型/排序后置校验 |
| P9 | Agent retry 计数与失败传播 |
| P10 | Tutor 上下文隔离 |
| P11 | 历史排序与过滤 |
| P12 | 配额耗尽 ⇔ 导出入口 |

**统计**：19 个测试文件 / 184 测试通过 / 3 秒跑完

---

## 12. Demo 流程

1. **设置 LLM**：填 DeepSeek API Key + Model
2. **选主题**：电商 → 看自动生成的 schema
3. **选难度+知识点**：L3 + EXISTS / NOT EXISTS
4. **出题**：看中文题面 + 表结构
5. **作答**：在 SQL 编辑器写答案，点提交
6. **判题**：绿色"正确"或红色"错误 + 差异摘要"
7. **答疑**：错题面板自动出诊断；可追问"为什么我用 IN 不行？"
8. **历史**：积累 5 题后开放报告
9. **报告**：看薄弱点和改进建议，导出 Markdown

---

## 13. 部署与隐私

**部署**：
- GitHub Pages 一键部署（`.github/workflows/pages.yml`）
- 也可本地 `python -m http.server` 即开即用

**隐私**：
- API Key **永不外泄**：仅存 localStorage，仅向用户配置端点发送
- 出站白名单由 Property 2 形式化保证（PBT 测试守护）
- 不使用任何 telemetry / 错误上报

**CORS**：用户配置的 LLM 端点必须允许跨域；常见解决方案有兼容代理或本地 Ollama

---

## 14. 未来工作

- **vendor/ 离线兜底**：把 LangGraph + sql.js 镜像到仓库，CDN 不通时仍可用
- **真 Web Worker 在生产模式启用**：当前在 jsdom 测试用主线程沙箱
- **更多业务主题**：金融、医疗、物流……
- **多人对战模式**：实时 PK 同一道题
- **错题本导出**：把历史错题打包成可重做的 JSON

---

## 15. 致谢与问答

**致谢**：
- 课程对齐：复习 PPT 提供的难点清单
- 技术栈：sql.js / fast-check / Vitest / MSW
- 设计参考：LangGraph (Python) 的图编排范式

**问答时间** 🙋
