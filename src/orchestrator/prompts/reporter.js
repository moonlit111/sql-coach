// Prompt template for Reporter_Agent (R16, [OPT] in v1).
//
// Validates: R16.1 (gated on ≥5 answers), R16.2 (per-topic / per-difficulty
// stats), R16.3 (≥1 concrete next-step recommendation), R16.4 (structured
// output for export — JSON now drives the visualised report).
//
// The reporter returns STRICT JSON with three sections:
//   - scores[]:        multi-dimensional capability scores (each 0-10)
//   - weakTopics[]:    the 3 weakest topics with concrete advice
//   - strengths[]:     2-4 strong topic ids
//   - summary:         1-2 sentence overall narrative
//   - recommendation:  ≥1 concrete next-step learning suggestion
// Deterministic statistics (per-topic / per-difficulty correctness rates)
// are derived in JS from the answer history, not asked of the model — that
// keeps charts truthful even when the model hallucinates.

import { TOPICS } from '../../data/topics.js';

const TOPIC_ZH = Object.fromEntries(TOPICS.map((t) => [t.id, t.zh]));

const SYSTEM = `你是 SQL 学习能力分析助手。仅输出严格 JSON,无任何 Markdown 包裹、无解释、无表情符号。

JSON 形如:
{
  "summary": "1-2 句的整体表现概览",
  "scores": [
    { "name": "SQL 基础语法", "score": 0-10, "max": 10, "comment": "≤30 字" },
    { "name": "联表查询",     "score": 0-10, "max": 10, "comment": "..." },
    { "name": "聚合与分组",   "score": 0-10, "max": 10, "comment": "..." },
    { "name": "子查询与 EXISTS", "score": 0-10, "max": 10, "comment": "..." },
    { "name": "集合运算",     "score": 0-10, "max": 10, "comment": "..." }
  ],
  "weakTopics": [
    { "id": "<topic_id>", "name": "<中文名>", "rate": 0.0-1.0, "advice": "≤50 字针对性建议" }
  ],
  "strengths": ["<topic_id>", "..."],
  "recommendation": "≥1 条具体的下一步学习建议(≤120 字)"
}

要求:
- scores 必须正好 5 个维度,顺序固定: SQL 基础语法 / 联表查询 / 聚合与分组 / 子查询与 EXISTS / 集合运算
- score 与对应知识点的实际表现挂钩;数据不足的维度给保守评分(5-6)并在 comment 里说明
- weakTopics 取 1-3 条,按错误率排序,id 必须出自给定的 topic 列表
- strengths 取 2-4 条 id,同样出自 topic 列表
- 不输出任何额外字段;不要用 \`\`\`json 包裹`;

/**
 * @param {{ history: Array<any> }} args
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function buildPrompt({ history }) {
  const stats = summariseHistory(history);
  // Hand the model the topic catalogue so it can map ids → display names
  // and never invent topic ids that don't exist in our taxonomy.
  const topicCatalogue = TOPICS.map((t) => ({ id: t.id, zh: t.zh, minLevel: t.minLevel }));
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        '答题统计:\n' + JSON.stringify(stats, null, 2)
        + '\n\n知识点目录(id → 中文名):\n' + JSON.stringify(topicCatalogue, null, 2),
    },
  ];
}

/**
 * Aggregate per-topic and per-difficulty correctness from a list of
 * answer records. Reads denormalised fields (`questionTopics`,
 * `questionDifficulty`) written by main.js submit handler; falls back
 * to the nested `question` object for older records.
 *
 * @param {Array<any>} history
 */
export function summariseHistory(history) {
  /** @type {Record<string, { total:number, correct:number }>} */
  const byTopic = {};
  /** @type {Record<string, { total:number, correct:number }>} */
  const byDifficulty = {};

  for (const a of history ?? []) {
    const correct = !!a.verdict?.correct;
    const topics = a.questionTopics ?? a.question?.topics ?? [];
    const difficulty = a.questionDifficulty ?? a.question?.difficulty;
    for (const t of topics) {
      if (!byTopic[t]) byTopic[t] = { total: 0, correct: 0 };
      byTopic[t].total += 1;
      if (correct) byTopic[t].correct += 1;
    }
    if (difficulty) {
      if (!byDifficulty[difficulty]) byDifficulty[difficulty] = { total: 0, correct: 0 };
      byDifficulty[difficulty].total += 1;
      if (correct) byDifficulty[difficulty].correct += 1;
    }
  }

  // Attach friendly names so the model doesn't have to guess.
  /** @type {Record<string, { total:number, correct:number, name:string, rate:number }>} */
  const byTopicNamed = {};
  for (const [id, v] of Object.entries(byTopic)) {
    byTopicNamed[id] = {
      ...v,
      name: TOPIC_ZH[id] ?? id,
      rate: v.total > 0 ? Number((v.correct / v.total).toFixed(2)) : 0,
    };
  }

  return {
    byTopic: byTopicNamed,
    byDifficulty,
    total: (history ?? []).length,
    correctTotal: (history ?? []).filter((a) => a?.verdict?.correct).length,
  };
}

/**
 * Parse the model's strict JSON response into a typed Report object.
 * Tolerates whitespace, an accidental ```json fence, or a leading sentence
 * before the JSON brace by extracting the first balanced `{...}` block.
 * Throws on unparseable / structurally invalid input — callers fall back
 * to a placeholder report built from `summariseHistory` only.
 *
 * @param {string} content  raw model output
 * @returns {{
 *   summary: string,
 *   scores: Array<{ name:string, score:number, max:number, comment?:string }>,
 *   weakTopics: Array<{ id:string, name?:string, rate:number, advice?:string }>,
 *   strengths: string[],
 *   recommendation: string,
 * }}
 */
export function parseReport(content) {
  if (typeof content !== 'string') throw new Error('reporter.parse: empty content');
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Take the first balanced top-level brace pair (defensive; the model
  // sometimes prefaces with a sentence even when told not to).
  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('reporter.parse: no JSON object found');
  let depth = 0;
  let end = -1;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('reporter.parse: unterminated JSON object');
  const obj = JSON.parse(trimmed.slice(start, end + 1));
  // Soft validation — fill defaults rather than throw for missing optional
  // fields so the visual report still renders even with a sparse model.
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    scores: Array.isArray(obj.scores) ? obj.scores
      .filter((s) => s && typeof s.name === 'string' && Number.isFinite(s.score))
      .map((s) => ({
        name: s.name,
        score: Math.max(0, Math.min(10, Number(s.score))),
        max: Number.isFinite(s.max) ? Number(s.max) : 10,
        comment: typeof s.comment === 'string' ? s.comment : '',
      })) : [],
    weakTopics: Array.isArray(obj.weakTopics) ? obj.weakTopics
      .filter((t) => t && typeof t.id === 'string')
      .map((t) => ({
        id: t.id,
        name: typeof t.name === 'string' ? t.name : (TOPIC_ZH[t.id] ?? t.id),
        rate: Number.isFinite(t.rate) ? Number(t.rate) : 0,
        advice: typeof t.advice === 'string' ? t.advice : '',
      })) : [],
    strengths: Array.isArray(obj.strengths)
      ? obj.strengths.filter((s) => typeof s === 'string')
      : [],
    recommendation: typeof obj.recommendation === 'string' ? obj.recommendation : '',
  };
}
