// Feature: sqlense, Property 6: Safety filter exactness
// Validates: Requirements R11.1, R11.2

import { describe, it, expect } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { safetyFilter } from '../../src/sandbox/safety-filter.js';

const ident = () => fc.constantFrom('id', 'name', 'total', 'price', 't1', 't2', 'users', 'orders');
const FORBIDDEN_WORDS = ['DROP', 'ALTER', 'TRUNCATE', 'ATTACH', 'DETACH', 'PRAGMA'];

// (a) pure SELECTs that mention forbidden words ONLY inside string literals → must accept
const pureSelectWithForbiddenInString = () =>
  fc.tuple(ident(), fc.constantFrom(...FORBIDDEN_WORDS)).map(
    ([t, kw]) => `SELECT '${kw} TABLE' FROM ${t}`
  );

// (b) statements with a forbidden keyword as an actual token → must reject
const forbiddenStatement = () =>
  fc.tuple(fc.constantFrom(...FORBIDDEN_WORDS), ident()).map(([kw, t]) => {
    if (kw === 'PRAGMA') return `PRAGMA ${t}`;
    if (kw === 'ATTACH') return `ATTACH DATABASE 'x' AS ${t}`;
    if (kw === 'DETACH') return `DETACH DATABASE ${t}`;
    if (kw === 'TRUNCATE') return `TRUNCATE TABLE ${t}`;
    if (kw === 'ALTER') return `ALTER TABLE ${t} ADD COLUMN c INT`;
    return `DROP TABLE ${t}`;
  });

// (c) DML statements
const dmlStatement = () =>
  fc.tuple(fc.constantFrom('INSERT', 'UPDATE', 'DELETE', 'REPLACE'), ident()).map(([kind, t]) => {
    if (kind === 'INSERT') return `INSERT INTO ${t} VALUES (1)`;
    if (kind === 'UPDATE') return `UPDATE ${t} SET a = 1`;
    if (kind === 'REPLACE') return `REPLACE INTO ${t} VALUES (1)`;
    return `DELETE FROM ${t}`;
  });

describe('safetyFilter — property: forbidden in string literal is accepted', () => {
  test.prop({ sql: pureSelectWithForbiddenInString() }, { numRuns: 100 })(
    'forbidden keyword inside a string literal does not trigger rejection',
    ({ sql }) => {
      const r = safetyFilter(sql, { allowDml: false });
      expect(r.ok).toBe(true);
    }
  );
});

describe('safetyFilter — property: forbidden tokens are rejected', () => {
  test.prop({ sql: forbiddenStatement() }, { numRuns: 100 })(
    'real forbidden keyword as a token is always rejected',
    ({ sql }) => {
      const r = safetyFilter(sql, { allowDml: false });
      expect(r.ok).toBe(false);
      expect(typeof r.reason).toBe('string');
    }
  );

  test.prop({ sql: forbiddenStatement() }, { numRuns: 30 })(
    'forbidden remains rejected even with allowDml=true',
    ({ sql }) => {
      const r = safetyFilter(sql, { allowDml: true });
      expect(r.ok).toBe(false);
    }
  );
});

describe('safetyFilter — property: DML respects allowDml flag', () => {
  test.prop({ sql: dmlStatement() }, { numRuns: 100 })(
    'DML rejected when allowDml=false; accepted when allowDml=true',
    ({ sql }) => {
      const denied = safetyFilter(sql, { allowDml: false });
      expect(denied.ok).toBe(false);
      const allowed = safetyFilter(sql, { allowDml: true });
      expect(allowed.ok).toBe(true);
    }
  );
});

describe('safetyFilter — examples', () => {
  it.each(FORBIDDEN_WORDS)('rejects forbidden keyword %s', (kw) => {
    let sql;
    if (kw === 'PRAGMA') sql = 'PRAGMA foreign_keys = ON';
    else if (kw === 'ATTACH') sql = "ATTACH DATABASE 'x' AS y";
    else if (kw === 'DETACH') sql = 'DETACH DATABASE y';
    else if (kw === 'TRUNCATE') sql = 'TRUNCATE TABLE t';
    else if (kw === 'ALTER') sql = 'ALTER TABLE t ADD COLUMN c INT';
    else sql = 'DROP TABLE t';
    const r = safetyFilter(sql, { allowDml: false });
    expect(r.ok).toBe(false);
  });

  it('accepts pure SELECT', () => {
    expect(safetyFilter('SELECT * FROM t', { allowDml: false }).ok).toBe(true);
  });

  it('accepts SELECT with forbidden words inside strings', () => {
    expect(safetyFilter("SELECT 'DROP' FROM t", { allowDml: false }).ok).toBe(true);
    expect(safetyFilter("SELECT 'ALTER TABLE x' FROM t", { allowDml: false }).ok).toBe(true);
  });

  it('rejects INSERT under allowDml=false', () => {
    expect(safetyFilter('INSERT INTO t VALUES (1)', { allowDml: false }).ok).toBe(false);
  });
  it('rejects UPDATE under allowDml=false', () => {
    expect(safetyFilter('UPDATE t SET a = 1', { allowDml: false }).ok).toBe(false);
  });
  it('rejects DELETE under allowDml=false', () => {
    expect(safetyFilter('DELETE FROM t', { allowDml: false }).ok).toBe(false);
  });
  it('rejects REPLACE under allowDml=false', () => {
    expect(safetyFilter('REPLACE INTO t VALUES (1)', { allowDml: false }).ok).toBe(false);
  });

  it('accepts INSERT/UPDATE/DELETE/REPLACE under allowDml=true', () => {
    expect(safetyFilter('INSERT INTO t VALUES (1)', { allowDml: true }).ok).toBe(true);
    expect(safetyFilter('UPDATE t SET a = 1', { allowDml: true }).ok).toBe(true);
    expect(safetyFilter('DELETE FROM t', { allowDml: true }).ok).toBe(true);
    expect(safetyFilter('REPLACE INTO t VALUES (1)', { allowDml: true }).ok).toBe(true);
  });

  it('does not block on parser failure but still scans tokens', () => {
    // garbage but no forbidden token → should NOT auto-reject (R18.5)
    const r = safetyFilter('???', { allowDml: false });
    // Tokenizer may throw on '?'; the filter should still respond ok (non-rejected) since no forbidden tokens exist.
    expect(r.ok).toBe(true);
  });
});
