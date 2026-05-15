// Feature: sql-coach, Property 8: Difficulty / topic / ordering post-checks
// Validates: Requirements R5.2, R5.3, R7.4, R8.4, R8.5, R9.1, R9.2, R9.3,
//            R9.4, R9.5, R9.6, R19.1, R19.2, R19.3
//
// We test the post-validator (`validateQuestion`) directly because the LLM
// call surface is a thin shell around it — by isolating the validator we
// keep the property test fast and deterministic, and avoid coupling to
// MSW/sandbox internals. The LLM-driven retry loop is covered separately
// by Property 9 in graph.property.test.js.

import { describe, it, expect } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { validateQuestion } from '../../src/orchestrator/nodes/question-gen.js';

// ---------------------------------------------------------------------------
// Helpers — build candidate questions in known-good and known-bad shapes
// ---------------------------------------------------------------------------

const baseValidL1 = () => ({
  prompt: '查询 users 表中的所有 id',
  refSql: 'SELECT id FROM users',
  topics: ['single_table_select'],
  difficulty: 'L1',
  is_ordered: false,
});

const baseValidL3WithExists = () => ({
  prompt: '查询存在订单的用户 id',
  refSql: 'SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
  topics: ['exists_not_exists', 'correlated_subquery'],
  difficulty: 'L3',
  is_ordered: false,
});

const baseValidL3Except = () => ({
  prompt: '查询从未下过订单的用户 id（注意 MySQL 不直接支持 EXCEPT，可用 NOT EXISTS 改写）',
  refSql: 'SELECT id FROM users EXCEPT SELECT user_id FROM orders',
  topics: ['set_operation_except'],
  difficulty: 'L3',
  is_ordered: false,
});

const baseValidL4 = () => ({
  prompt: '查询有订单的用户的 id 与订单数，按订单数从高到低排序',
  refSql:
    'SELECT u.id, COUNT(o.id) FROM users u JOIN orders o ON o.user_id = u.id ' +
    'GROUP BY u.id HAVING COUNT(o.id) > 0 ORDER BY COUNT(o.id) DESC',
  topics: ['join_inner', 'group_by_having', 'order_by_limit'],
  difficulty: 'L4',
  is_ordered: true,
});

const baseValidSetVsJoin = () => ({
  prompt: '请同时给出"集合查询写法"与"连接查询写法"',
  refSql: 'SELECT user_id FROM orders INTERSECT SELECT id FROM users',
  refSqlAlt: 'SELECT DISTINCT u.id FROM users u JOIN orders o ON o.user_id = u.id',
  topics: ['set_vs_join_compare', 'set_operation_intersect'],
  difficulty: 'L4',
  is_ordered: false,
});

// ---------------------------------------------------------------------------
// Example-style assertions
// ---------------------------------------------------------------------------

describe('validateQuestion — accepts well-formed questions', () => {
  it('accepts a minimal L1 question', () => {
    const r = validateQuestion(baseValidL1());
    expect(r.ok).toBe(true);
  });

  it('accepts an L3 question with EXISTS + correlated_subquery', () => {
    const r = validateQuestion(baseValidL3WithExists());
    expect(r.ok).toBe(true);
  });

  it('accepts an L3 EXCEPT question with the MySQL/NOT EXISTS note', () => {
    const r = validateQuestion(baseValidL3Except());
    expect(r.ok).toBe(true);
  });

  it('accepts an L4 question combining ≥2 topics', () => {
    const r = validateQuestion(baseValidL4());
    expect(r.ok).toBe(true);
  });

  it('accepts a set_vs_join_compare question with refSqlAlt', () => {
    const r = validateQuestion(baseValidSetVsJoin());
    expect(r.ok).toBe(true);
  });
});

describe('validateQuestion — rejects each violation class', () => {
  it('rejects null/non-object responses', () => {
    expect(validateQuestion(null).ok).toBe(false);
    expect(validateQuestion(undefined).ok).toBe(false);
    expect(validateQuestion(42).ok).toBe(false);
  });

  it('rejects when prompt or refSql is missing', () => {
    const q = { ...baseValidL1() }; delete q.prompt;
    expect(validateQuestion(q).ok).toBe(false);
    const q2 = { ...baseValidL1() }; delete q2.refSql;
    expect(validateQuestion(q2).ok).toBe(false);
  });

  it('rejects when topics is empty or missing (R5.2)', () => {
    const q = { ...baseValidL1(), topics: [] };
    expect(validateQuestion(q).ok).toBe(false);
    const q2 = { ...baseValidL1() }; delete q2.topics;
    expect(validateQuestion(q2).ok).toBe(false);
  });

  it('rejects a prompt without any Chinese characters (R5.3)', () => {
    const q = { ...baseValidL1(), prompt: 'select all users' };
    expect(validateQuestion(q).ok).toBe(false);
  });

  it('rejects a refSql with a non-ASCII identifier (R5.3, relaxed)', () => {
    const q = { ...baseValidL1(), refSql: 'SELECT 列 FROM users' };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ASCII/);
  });

  it('accepts a refSql with Chinese inside a string literal (R5.3, relaxed)', () => {
    const q = {
      ...baseValidL1(),
      // Chinese value matches Chinese seed data — practical case.
      refSql: "SELECT id FROM users WHERE name = '张三'",
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(true);
  });

  it('normalises fullwidth punctuation outside string literals', () => {
    const q = {
      ...baseValidL1(),
      // Fullwidth comma between SELECT columns — a typical CJK-IME typo.
      refSql: 'SELECT id，name FROM users',
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(true);
    // The normaliser should have rewritten the SQL in place.
    expect(q.refSql).toBe('SELECT id,name FROM users');
  });

  it('rejects an unclosed string literal in refSql', () => {
    const q = {
      ...baseValidL1(),
      refSql: "SELECT id FROM users WHERE name = '张三",
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/未闭合|ASCII/);
  });

  it('rejects an L3 question that lacks a course-emphasis topic (R8.4 / R9)', () => {
    const q = {
      prompt: '查询订单数大于 1 的用户',
      refSql:
        'SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(*) > 1',
      topics: ['group_by_having'],
      difficulty: 'L3',
      is_ordered: false,
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/L3/);
  });

  it('rejects an L4 question with only one topic (R8.5)', () => {
    const q = {
      prompt: '查询所有订单',
      refSql: 'SELECT id FROM orders',
      topics: ['single_table_select'],
      difficulty: 'L4',
      is_ordered: false,
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/L4/);
  });

  it('rejects when refSql has ORDER BY but is_ordered=false (R19.1)', () => {
    const q = {
      ...baseValidL1(),
      refSql: 'SELECT id FROM users ORDER BY id',
      is_ordered: false,
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/is_ordered/);
  });

  it('rejects when prompt mentions 排序 but is_ordered=false (R19.2)', () => {
    const q = {
      ...baseValidL1(),
      prompt: '查询 users 表的 id，按 id 升序排序',
      refSql: 'SELECT id FROM users',
      is_ordered: false,
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/is_ordered/);
  });

  it('rejects when is_ordered=true but neither refSql nor prompt orders', () => {
    const q = { ...baseValidL1(), is_ordered: true };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/is_ordered/);
  });

  it('rejects an EXCEPT topic without "MySQL" in the prompt (R7.4)', () => {
    const q = {
      ...baseValidL3Except(),
      prompt: '查询从未下过订单的用户 id（用 NOT EXISTS 改写）',
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/MySQL/);
  });

  it('rejects an EXCEPT topic without NOT IN / NOT EXISTS hint (R7.4)', () => {
    const q = {
      ...baseValidL3Except(),
      prompt: '查询从未下过订单的用户 id（注意 MySQL 不直接支持 EXCEPT）',
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/NOT IN|NOT EXISTS/);
  });

  it('rejects group_by_having topic when refSql lacks GROUP BY/HAVING', () => {
    const q = {
      prompt: '查询所有用户 id',
      refSql: 'SELECT id FROM users',
      topics: ['group_by_having'],
      difficulty: 'L2',
      is_ordered: false,
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/group_by_having/);
  });

  it('rejects exists_not_exists topic when refSql lacks EXISTS', () => {
    const q = {
      prompt: '查询用户 id',
      refSql: 'SELECT id FROM users',
      topics: ['exists_not_exists'],
      difficulty: 'L3',
      is_ordered: false,
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exists_not_exists/);
  });

  it('rejects set_operation_union when refSql lacks UNION', () => {
    const q = {
      prompt: '查询用户 id',
      refSql: 'SELECT id FROM users INTERSECT SELECT user_id FROM orders',
      topics: ['set_operation_union'],
      difficulty: 'L2',
      is_ordered: false,
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/set_operation_union/);
  });

  it('rejects set_vs_join_compare without refSqlAlt (R9.6)', () => {
    const q = { ...baseValidSetVsJoin() };
    delete q.refSqlAlt;
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/refSqlAlt/);
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

const arbDifficulty = fc.constantFrom('L1', 'L2', 'L3', 'L4');

/** ASCII-only refSql containing one or more set-op clauses for parser flags. */
const arbAsciiRefSql = fc.constantFrom(
  'SELECT id FROM users',
  'SELECT id FROM users WHERE id > 0',
  'SELECT id FROM users ORDER BY id',
  'SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id',
);

const arbChinesePrompt = fc.constantFrom(
  '查询 users 表的 id',
  '查询所有用户的 id 列表',
  '请输出 users 表中的 id 字段',
);

test.prop(
  {
    difficulty: arbDifficulty,
    topicsBag:  fc.array(
      fc.constantFrom(
        'single_table_select', 'where_filter',
      ),
      { minLength: 0, maxLength: 3 },
    ),
    prompt: arbChinesePrompt,
    refSql: arbAsciiRefSql,
  },
  { numRuns: 100 },
)(
  'L3 with no required topic ⇒ rejected; L4 with <2 topics ⇒ rejected (R8.4 / R8.5)',
  ({ difficulty, topicsBag, prompt, refSql }) => {
    const topics = topicsBag.length > 0 ? topicsBag : ['single_table_select'];
    // is_ordered consistent with the chosen refSql / prompt
    const has排序 = /按.*?排序/.test(prompt);
    const orderBy = /\bORDER BY\b/i.test(refSql);
    const candidate = {
      prompt, refSql, topics, difficulty,
      is_ordered: orderBy || has排序,
    };
    const r = validateQuestion(candidate);
    if (difficulty === 'L3') {
      // None of the chosen `topicsBag` ids are L3-required; therefore reject.
      expect(r.ok).toBe(false);
    } else if (difficulty === 'L4' && topics.length < 2) {
      expect(r.ok).toBe(false);
    } else {
      // L1/L2 with simple topics over a basic SELECT → should be acceptable.
      expect(r.ok).toBe(true);
    }
  },
);

test.prop(
  {
    // Test that ASCII-only refSql passes the codepoint check whatever the
    // exact ASCII content is, when the rest of the question is valid.
    asciiNoise: fc.string({ minLength: 0, maxLength: 16 })
      .filter((s) => /^[\x20-\x7E]*$/.test(s)),
  },
  { numRuns: 100 },
)(
  'ASCII-only refSql passes the codepoint scan (R5.3)',
  ({ asciiNoise }) => {
    const q = {
      prompt: '查询 users 表的 id',
      refSql: 'SELECT id FROM users -- ' + asciiNoise,
      topics: ['single_table_select'],
      difficulty: 'L1',
      is_ordered: false,
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(true);
  },
);

test.prop(
  {
    cjk: fc.string({ minLength: 1, maxLength: 4 })
      // Always include at least one CJK codepoint (U+4E00–U+9FFF).
      .map((s) => s + '中'),
  },
  { numRuns: 50 },
)(
  'A non-ASCII char outside strings/comments triggers rejection (R5.3, relaxed)',
  ({ cjk }) => {
    const q = {
      prompt: '查询 users 表的 id',
      // CJK as an identifier (not in a comment, not in a string) — must
      // still be rejected under the relaxed rule.
      refSql: `SELECT ${cjk} FROM users`,
      topics: ['single_table_select'],
      difficulty: 'L1',
      is_ordered: false,
    };
    const r = validateQuestion(q);
    expect(r.ok).toBe(false);
  },
);
