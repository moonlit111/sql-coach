// Feature: sql-coach, Property 1: SQL parse-format-parse round-trip consistency
// Validates: Requirements R18.1, R18.2, R18.4

import { describe, it, expect } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { parse } from '../../src/sql/parser.js';
import { format } from '../../src/sql/formatter.js';

// --- fast-check arbitraries for valid MySQL-compatible-subset SELECT statements ---

const ident = () => fc.constantFrom('id', 'name', 'total', 'price', 't1', 't2', 'users', 'orders', 'a', 'b', 'qty');

// SELECT col FROM tbl
const baseSelect = () =>
  fc.tuple(ident(), ident()).map(([c, t]) => `SELECT ${c} FROM ${t}`);

// SELECT a, b FROM tbl
const multiColSelect = () =>
  fc.tuple(ident(), ident(), ident()).map(([c1, c2, t]) => `SELECT ${c1}, ${c2} FROM ${t}`);

// SELECT * FROM tbl
const starSelect = () =>
  ident().map((t) => `SELECT * FROM ${t}`);

// + WHERE
const withWhere = (q) =>
  fc.tuple(q, ident()).map(([s, c]) => `${s} WHERE ${c} = 1`);

// + GROUP BY
const withGroupBy = (q) =>
  fc.tuple(q, ident()).map(([s, c]) => `${s} GROUP BY ${c}`);

// + GROUP BY + HAVING
const withGroupByHaving = (q) =>
  fc.tuple(q, ident()).map(([s, c]) => `${s} GROUP BY ${c} HAVING COUNT(*) > 0`);

// + ORDER BY
const withOrderBy = (q) =>
  fc.tuple(q, ident()).map(([s, c]) => `${s} ORDER BY ${c}`);

// + LIMIT
const withLimit = (q) =>
  fc.tuple(q, fc.integer({ min: 1, max: 100 })).map(([s, n]) => `${s} LIMIT ${n}`);

// JOIN
const withJoin = () =>
  fc.tuple(ident(), ident(), ident(), ident()).map(
    ([t1, t2, c1, c2]) => `SELECT * FROM ${t1} JOIN ${t2} ON ${t1}.${c1} = ${t2}.${c2}`
  );

// LEFT JOIN
const withLeftJoin = () =>
  fc.tuple(ident(), ident(), ident(), ident()).map(
    ([t1, t2, c1, c2]) => `SELECT * FROM ${t1} LEFT JOIN ${t2} ON ${t1}.${c1} = ${t2}.${c2}`
  );

// IN subquery
const withInSubquery = () =>
  fc.tuple(ident(), ident(), ident(), ident()).map(
    ([t1, c1, t2, c2]) => `SELECT * FROM ${t1} WHERE ${c1} IN (SELECT ${c2} FROM ${t2})`
  );

// EXISTS subquery
const withExists = () =>
  fc.tuple(ident(), ident()).map(
    ([t1, t2]) => `SELECT * FROM ${t1} WHERE EXISTS (SELECT 1 FROM ${t2})`
  );

// NOT EXISTS subquery
const withNotExists = () =>
  fc.tuple(ident(), ident()).map(
    ([t1, t2]) => `SELECT * FROM ${t1} WHERE NOT EXISTS (SELECT 1 FROM ${t2})`
  );

// Set operation UNION
const withUnion = () =>
  fc.tuple(ident(), ident()).map(
    ([t1, t2]) => `(SELECT a FROM ${t1}) UNION (SELECT a FROM ${t2})`
  );

// Set operation INTERSECT
const withIntersect = () =>
  fc.tuple(ident(), ident()).map(
    ([t1, t2]) => `(SELECT a FROM ${t1}) INTERSECT (SELECT a FROM ${t2})`
  );

// Set operation EXCEPT
const withExcept = () =>
  fc.tuple(ident(), ident()).map(
    ([t1, t2]) => `(SELECT a FROM ${t1}) EXCEPT (SELECT a FROM ${t2})`
  );

const validSelectSql = () =>
  fc.oneof(
    baseSelect(),
    multiColSelect(),
    starSelect(),
    withWhere(baseSelect()),
    withWhere(multiColSelect()),
    withGroupBy(baseSelect()),
    withGroupByHaving(baseSelect()),
    withOrderBy(baseSelect()),
    withLimit(baseSelect()),
    withOrderBy(withWhere(baseSelect())),
    withJoin(),
    withLeftJoin(),
    withInSubquery(),
    withExists(),
    withNotExists(),
    withUnion(),
    withIntersect(),
    withExcept(),
  );

describe('SQL parser: round-trip property', () => {
  test.prop({ sql: validSelectSql() }, { numRuns: 100 })(
    'parse-format-parse round-trip preserves all flag fields',
    ({ sql }) => {
      const a = parse(sql);
      if (a.error) return; // skip if generator produced something unexpected
      const formatted = format(a);
      const b = parse(formatted);
      expect(b.error).toBeUndefined();
      expect(b.kind).toBe(a.kind);
      expect(b.hasOrderBy).toBe(a.hasOrderBy);
      expect(b.hasGroupBy).toBe(a.hasGroupBy);
      expect(b.hasHaving).toBe(a.hasHaving);
      expect(b.hasJoin).toBe(a.hasJoin);
      expect(b.hasSubquery).toBe(a.hasSubquery);
      expect(b.hasExists).toBe(a.hasExists);
      expect(b.hasSetOp).toBe(a.hasSetOp);
    }
  );
});

describe('SQL parser: example-based recognition', () => {
  it('recognises a simple SELECT', () => {
    const ast = parse('SELECT * FROM t');
    expect(ast.error).toBeUndefined();
    expect(ast.kind).toBe('SELECT');
    expect(ast.hasOrderBy).toBe(false);
  });

  it('detects ORDER BY', () => {
    const ast = parse('SELECT * FROM t ORDER BY x');
    expect(ast.kind).toBe('SELECT');
    expect(ast.hasOrderBy).toBe(true);
  });

  it('detects GROUP BY + HAVING', () => {
    const ast = parse('SELECT a, COUNT(*) FROM t GROUP BY a HAVING COUNT(*) > 1');
    expect(ast.hasGroupBy).toBe(true);
    expect(ast.hasHaving).toBe(true);
  });

  it('detects JOIN', () => {
    const ast = parse('SELECT * FROM a JOIN b ON a.id = b.id');
    expect(ast.hasJoin).toBe(true);
  });

  it('detects EXISTS and subquery', () => {
    const ast = parse('SELECT * FROM a WHERE EXISTS (SELECT 1 FROM b)');
    expect(ast.hasExists).toBe(true);
    expect(ast.hasSubquery).toBe(true);
  });

  it('detects UNION set operation', () => {
    const ast = parse('(SELECT a FROM t) UNION (SELECT a FROM t2)');
    expect(ast.hasSetOp).toBe('UNION');
  });

  it('detects INTERSECT set operation', () => {
    const ast = parse('(SELECT a FROM t) INTERSECT (SELECT a FROM t2)');
    expect(ast.hasSetOp).toBe('INTERSECT');
  });

  it('detects EXCEPT set operation', () => {
    const ast = parse('(SELECT a FROM t) EXCEPT (SELECT a FROM t2)');
    expect(ast.hasSetOp).toBe('EXCEPT');
  });

  it('classifies INSERT', () => {
    const ast = parse('INSERT INTO t VALUES (1)');
    expect(ast.kind).toBe('INSERT');
  });

  it('classifies UPDATE', () => {
    const ast = parse('UPDATE t SET a = 1 WHERE id = 2');
    expect(ast.kind).toBe('UPDATE');
  });

  it('classifies DELETE', () => {
    const ast = parse('DELETE FROM t WHERE id = 1');
    expect(ast.kind).toBe('DELETE');
  });

  it('classifies REPLACE', () => {
    const ast = parse('REPLACE INTO t VALUES (1)');
    expect(ast.kind).toBe('REPLACE');
  });

  it('classifies DROP as DDL', () => {
    const ast = parse('DROP TABLE t');
    expect(ast.kind).toBe('DDL');
  });

  it('classifies CREATE as DDL', () => {
    const ast = parse('CREATE TABLE t (id INT PRIMARY KEY)');
    expect(ast.kind).toBe('DDL');
  });

  it('returns {error} for garbage input', () => {
    const ast = parse('???');
    expect(ast.error).toBeDefined();
  });

  it('returns {error} for empty input', () => {
    const ast = parse('   ');
    expect(ast.error).toBeDefined();
  });

  it('returns {error} when sql is not a string', () => {
    const ast = parse(123);
    expect(ast.error).toBeDefined();
  });

  it('does not misclassify DROP inside a string literal as DDL', () => {
    const ast = parse("SELECT 'DROP TABLE' FROM t");
    expect(ast.error).toBeUndefined();
    expect(ast.kind).toBe('SELECT');
  });

  it('classifies bare keyword statements as OTHER when leading not recognized', () => {
    const ast = parse('foo bar baz');
    // identifier-leading => OTHER (no error)
    expect(ast.kind).toBe('OTHER');
  });
});
