# SQL 教练 (SQL Coach)

> 基于大模型 Agent 的 SQL 辅助学习系统 · 纯前端 · GitHub Pages 部署 · BYO LLM Key

[![Tests](https://img.shields.io/badge/tests-184%20passed-green)]() [![No Build](https://img.shields.io/badge/build--step-none-blue)]() [![Pure Frontend](https://img.shields.io/badge/backend-none-orange)]()

## 项目简介

SQL 教练是一个面向 SQL 学习者的纯前端学习系统：你在浏览器里选定业务主题、选难度和知识点，由 5 个 LLM Agent 协作生成数据库、出题、判题、答疑、出报告。所有数据只存在你的浏览器里，API Key 只发往你自己配置的 LLM 端点。

## 功能闭环

```
[选主题] → SchemaGen 生成 DDL+种子数据
   ↓
[出题]   → QuestionGen 按难度/知识点出题
   ↓
[作答]   → 用户在浏览器内 sql.js 执行 SQL
   ↓
[判题]   → Judge 比较结果集等价性（纯函数，不调 LLM）
   ↓
[答疑]   → Tutor 错题诊断 + 多轮追问（≥10 轮）
   ↓
[报告]   → Reporter 出能力雷达图 + 改进建议（可选）
```

## 快速开始

### 在线访问

部署到 GitHub Pages 后访问：`https://<你的用户名>.github.io/<仓库名>/`

### 本地运行

```bash
# 任一静态服务器即可，无需 npm install（除非要跑测试）
python -m http.server 5173
# 或者
npx http-server -c-1 -p 5173

# 然后浏览器打开 http://localhost:5173
```

### 配置 LLM

打开应用 → 点击「设置」→ 填写：
- **API Base URL**：你的 LLM 服务地址
- **API Key**：你的密钥
- **Model Name**：模型名

点「测试连接」确认配置正确，再开始练习。

## 支持的 LLM 端点

任何兼容 OpenAI Chat Completions 协议的端点都可以。常见配置：

| 提供商 | API Base URL | 示例 Model | 说明 |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | 需 `sk-...` key |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 兼容 OpenAI |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 兼容 OpenAI |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4` | 兼容 OpenAI |
| 本地 Ollama | `http://localhost:11434/v1` | `llama3` | 需配置 CORS |
| Claude (代理) | 自建反向代理 URL | `claude-3-5-sonnet` | 需自行架代理 |

## MySQL 兼容子集

系统在浏览器内用 sql.js (SQLite WASM) 执行，但生成的 SQL 严格使用同时在 MySQL 中合法的子集：

| 类别 | 允许 | 禁止 |
|---|---|---|
| **DDL** | `CREATE TABLE`、`PRIMARY KEY`、`FOREIGN KEY ... REFERENCES`、`UNIQUE`、`NOT NULL`、`DEFAULT` | `WITHOUT ROWID`、`AUTOINCREMENT`（用 `INTEGER PRIMARY KEY` 替代）、`PRAGMA`、`CHECK` |
| **类型** | `INT`、`BIGINT`、`DECIMAL(p,s)`、`VARCHAR(n)`、`CHAR(n)`、`TEXT`、`DATE`、`DATETIME` | SQLite 动态类型亲和 |
| **DML** | `INSERT INTO ... VALUES (...)` | `INSERT OR REPLACE`、`UPSERT` |
| **查询** | `SELECT`、`WHERE`、`GROUP BY`、`HAVING`、`ORDER BY`、`LIMIT`、各种 `JOIN`、`UNION [ALL]`、`INTERSECT`、`EXCEPT` | `IIF`、`PRINTF`、`GLOB`、`STRAIGHT_JOIN` |
| **函数** | `COUNT/SUM/AVG/MIN/MAX`、`UPPER/LOWER/LENGTH/SUBSTR/TRIM`、`COALESCE/IFNULL`、`CAST`、`CASE WHEN`、`ROUND/ABS/CEIL/FLOOR` | `IIF`（用 `CASE WHEN` 替代） |

**关于 `EXCEPT`**：sql.js 原生支持 `EXCEPT`，但 MySQL 不直接支持。涉及差集的题目，系统会在题面中说明并提供 `NOT IN` / `NOT EXISTS` 的等价写法。

## 课程对齐（教学难点）

系统重点覆盖以下教学难点（按课程要求强约束）：

- **GROUP BY + HAVING**：分组聚集
- **相关子查询**：依赖外层查询
- **EXISTS / NOT EXISTS**：存在量词
- **全称量词转化**：用 `NOT EXISTS` 模式表达"对所有 X 都成立"
- **集合运算（差集）**：`EXCEPT` 与 `NOT IN` / `NOT EXISTS` 等价改写
- **集合查询 vs 连接查询对比**：同一语义两种写法

L3 难度题目必含上述前 4 个难点之一；L4 难度题目必须组合 2 个以上知识点。

## 隐私声明

- API Key 仅存于浏览器 `localStorage`，**永不发往第三方**
- 系统只对两类目标发起出站请求：你配置的 LLM 端点 + ESM CDN（启动加载依赖时）
- 出站请求白名单由 [Property 2](docs/architecture.md#correctness-properties) 形式化保证
- 不使用任何 telemetry / 错误上报服务

## CORS 须知

浏览器跨域限制要求你配置的 LLM 端点必须允许从 GitHub Pages 域名跨域访问：

- **OpenAI / DeepSeek / 通义千问**：默认允许 CORS，开箱即用
- **本地 Ollama**：需要在启动时设置 `OLLAMA_ORIGINS=*` 环境变量
- **Claude / 其他不支持 CORS 的端点**：需自建反向代理（如 Cloudflare Worker）

如果浏览器报 CORS 错误，应用会显式提示，请检查端点配置。

## 运行测试

```bash
npm install   # 仅测试依赖；生产代码不依赖 node_modules
npm test
```

预期输出：
```
Test Files  19 passed (19)
     Tests  184 passed | 1 skipped (185)
```

测试涵盖 12 条正确性属性（Property-Based Testing），覆盖全部 19 条需求。

## 架构概览

```
┌──────────────────────────────────────────┐
│         浏览器（无后端）                   │
│  ┌────────────────────────────────────┐  │
│  │  原生 HTML + ESM JS + sql.js WASM   │  │
│  │  ┌────────┐ ┌────────┐ ┌────────┐  │  │
│  │  │SchemaGen│ │QuestionGen│ │ Judge │  │  │
│  │  └────────┘ └────────┘ └────────┘  │  │
│  │  ┌────────┐ ┌──────────┐           │  │
│  │  │ Tutor  │ │ Reporter │           │  │
│  │  └────────┘ └──────────┘           │  │
│  │       ↑ 自实现轻量编排器            │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
         ↓ 仅出站到用户配置的 LLM
   [OpenAI / DeepSeek / Ollama / ...]
```

详见 [docs/architecture.md](docs/architecture.md) 与 [docs/demo-deck.md](docs/demo-deck.md)。

## 目录结构

```
.
├── index.html                  # 入口页面（含 importmap）
├── styles/main.css
├── src/
│   ├── main.js                 # 应用启动 / 路由
│   ├── ui/                     # 视图层（原生 DOM）
│   ├── orchestrator/           # 5 个 Agent 节点 + 编排
│   │   ├── nodes/              # schema-gen / question-gen / judge / tutor / reporter
│   │   ├── prompts/            # 各 Agent 的提示词
│   │   ├── state.js            # AgentState 与不可变更新
│   │   └── graph.js            # 轻量编排器
│   ├── sandbox/                # sql.js 沙箱 + Web Worker
│   ├── sql/                    # 手写 tokenizer/parser/formatter
│   ├── judge/                  # 结果集等价比较（纯函数）
│   ├── llm/                    # OpenAI 兼容客户端 + 错误分类
│   ├── persist/                # localStorage 适配器
│   ├── settings/               # 设置模块
│   ├── i18n/                   # 中文 UI 文案
│   ├── data/                   # 16 知识点元数据
│   └── types.js                # JSDoc 类型定义
├── tests/                      # Vitest + fast-check + MSW
├── docs/                       # 架构文档 + 演示 PPT 骨架
└── .github/workflows/pages.yml # GitHub Pages 自动部署
```

## License

MIT
