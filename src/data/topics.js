// 16 Question_Topic taxonomy — single source of truth.
// Order, ids, Chinese names, and minLevel match design.md → "16 知识点 Taxonomy"
// exactly. Downstream code (QuestionGen post-validator, UI topic picker,
// Property 8 tests) imports from here.
//
// Requirements: R8.2 (16-topic coverage), R9.1–R9.6 (course-emphasis topics).

/**
 * @typedef {(
 *   | 'single_table_select' | 'where_filter' | 'order_by_limit'
 *   | 'aggregate_function'
 *   | 'join_inner' | 'join_outer' | 'join_self'
 *   | 'group_by_having'
 *   | 'subquery' | 'correlated_subquery'
 *   | 'exists_not_exists' | 'universal_quantifier'
 *   | 'set_operation_union' | 'set_operation_intersect' | 'set_operation_except'
 *   | 'set_vs_join_compare'
 * )} QuestionTopic
 */

/**
 * @typedef {Object} TopicMeta
 * @property {QuestionTopic} id              Stable identifier used in Question.topics.
 * @property {string}        zh              Chinese display name (R5.1).
 * @property {'L1'|'L2'|'L3'|'L4'} minLevel  Lowest difficulty this topic may appear at.
 * @property {boolean}      [isOrderedHint]  Topic implies ORDER BY in the prompt (R19.2).
 * @property {boolean}      [courseEmphasis] Marked as 课程重点 in design.md (R9).
 */

/** @type {readonly TopicMeta[]} */
export const TOPICS = Object.freeze([
  // L1 — single-table fundamentals (R8.2)
  { id: 'single_table_select',     zh: '单表查询',              minLevel: 'L1' },
  { id: 'where_filter',            zh: 'WHERE 过滤',            minLevel: 'L1' },
  { id: 'order_by_limit',          zh: '排序与分页',            minLevel: 'L1', isOrderedHint: true }, // R19.2

  // L2 — multi-table & aggregation (R8.2)
  { id: 'aggregate_function',      zh: '聚合函数',              minLevel: 'L2' },
  { id: 'join_inner',              zh: '内连接',                minLevel: 'L2' },
  { id: 'join_outer',              zh: '外连接',                minLevel: 'L2' },
  { id: 'join_self',               zh: '自连接',                minLevel: 'L2' },
  // 课程重点 — R9.1
  { id: 'group_by_having',         zh: '分组与 HAVING',         minLevel: 'L2', courseEmphasis: true },
  { id: 'subquery',                zh: '子查询',                minLevel: 'L2' },

  // L3 — advanced topics required for L3 difficulty distribution (R8.4)
  // 课程重点 — R9.2
  { id: 'correlated_subquery',     zh: '相关子查询',            minLevel: 'L3', courseEmphasis: true },
  // 课程重点 — R9.3
  { id: 'exists_not_exists',       zh: 'EXISTS / NOT EXISTS',   minLevel: 'L3', courseEmphasis: true },
  // 课程重点 — R9.4
  { id: 'universal_quantifier',    zh: '全称量词转化',          minLevel: 'L3', courseEmphasis: true },

  // Set operations (R8.2)
  { id: 'set_operation_union',     zh: '集合运算 UNION',        minLevel: 'L2' },
  { id: 'set_operation_intersect', zh: '集合运算 INTERSECT',    minLevel: 'L3' },
  // 课程重点 — R9.5
  { id: 'set_operation_except',    zh: '集合运算 EXCEPT / 差集', minLevel: 'L3', courseEmphasis: true },

  // L4 — synthesis (R8.5)
  // 课程重点 — R9.6 (set vs join comparison; requires refSqlAlt)
  { id: 'set_vs_join_compare',     zh: '集合查询 vs 连接查询对比', minLevel: 'L4', courseEmphasis: true },
]);

/**
 * Look up a topic record by id.
 * @param {string} id
 * @returns {TopicMeta | undefined}
 */
export function topicById(id) {
  return TOPICS.find((t) => t.id === id);
}

/**
 * IDs of the five 课程重点 topics (R9.1–R9.6).
 * @type {readonly QuestionTopic[]}
 */
export const COURSE_EMPHASIS_TOPICS = Object.freeze(
  TOPICS.filter((t) => t.courseEmphasis).map((t) => t.id),
);

/**
 * Any L3 question MUST have at least one topic from this set (R8.4 / Property 8).
 * Kept as an explicit list (rather than derived) because Property 8 references
 * exactly these four ids; changing one without updating the other would silently
 * weaken the post-validator.
 * @type {readonly QuestionTopic[]}
 */
export const L3_REQUIRED_TOPICS = Object.freeze([
  'correlated_subquery',
  'exists_not_exists',
  'universal_quantifier',
  'set_operation_except',
]);

export default TOPICS;
