// Feature: sqlense, Property 5: Sandbox baseline reset idempotency
// Validates: Requirements R10.6, R11.4
//
// Uses real sql.js (not mocked). Loads a fixed schema, then for any random
// sequence of safe DML (INSERT/UPDATE/DELETE) under allowDml=true:
//   - resetToBaseline() restores the database to the initial seed state in
//     multiset semantics for every table; AND
//   - calling resetToBaseline() multiple times is equivalent to calling it
//     once (idempotent).
//
// We also verify that a DML statement rejected by the safety filter
// (allowDml=false) does NOT mutate the database — the safety filter must
// short-circuit before sql.js ever sees the statement.

import { describe, it, expect, beforeAll } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Sandbox } from '../../src/sandbox/sandbox.js';
import { rowKey } from '../../src/judge/normalize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQLJS_DIST = path.resolve(HERE, '../../node_modules/sql.js/dist');

/** Resolve sql.js wasm/js artifacts from node_modules so jsdom tests can find them. */
function locateFile(file) {
  return path.join(SQLJS_DIST, file);
}

const FIXED_DDL = `
  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL
  );
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL
  );
`;
const FIXED_SEED = `
  INSERT INTO products (id, name, price) VALUES
    (1, 'Apple', 5.0),
    (2, 'Banana', 3.5),
    (3, 'Cherry', 12.0),
    (4, 'Durian', 30.0),
    (5, 'Elderberry', 8.5);
  INSERT INTO tags (id, label) VALUES
    (1, 'fruit'),
    (2, 'tropical'),
    (3, 'imported');
`;

let sandbox;
let baselineKeys;

async function snapshotKeys(sb, table) {
  const rs = await sb.exec(`SELECT * FROM ${table}`, { allowDml: false });
  if (rs && rs.kind) throw new Error(`SELECT failed: ${rs.message}`);
  return rs.rows.map(rowKey).sort();
}

beforeAll(async () => {
  sandbox = new Sandbox({ useWorker: false, sqlJsLocateFile: locateFile });
  const r = await sandbox.loadSchema(FIXED_DDL, FIXED_SEED);
  if (!r.ok) throw new Error(`loadSchema failed: ${r.error}`);
  baselineKeys = {
    products: await snapshotKeys(sandbox, 'products'),
    tags: await snapshotKeys(sandbox, 'tags'),
  };
}, 30000);

// ─── Generators ──────────────────────────────────────────────────────────

const dmlOp = fc.oneof(
  fc.integer({ min: 1, max: 5 }).map((id) => `DELETE FROM products WHERE id = ${id}`),
  fc.integer({ min: 6, max: 20 }).map(
    (id) => `INSERT INTO products (id, name, price) VALUES (${id}, 'X${id}', 1.0)`
  ),
  fc.integer({ min: 1, max: 5 }).map(
    (id) => `UPDATE products SET price = 999 WHERE id = ${id}`
  ),
  fc.integer({ min: 1, max: 3 }).map((id) => `DELETE FROM tags WHERE id = ${id}`)
);

const dmlSequence = () => fc.array(dmlOp, { minLength: 1, maxLength: 5 });

// ─── Property: reset returns to baseline (multiset) ──────────────────────

describe('Sandbox — Property 5: reset to baseline (multiset)', () => {
  test.prop({ ops: dmlSequence() }, { numRuns: 20 })(
    'arbitrary DML sequence + resetToBaseline yields baseline rows',
    async ({ ops }) => {
      // Apply each op in sequence (allowDml=true so they execute).
      for (const op of ops) {
        const r = await sandbox.exec(op, { allowDml: true });
        // Some ops may fail at the SQL level (e.g. INSERT colliding on PK).
        // That's acceptable — we only need the reset to restore baseline.
        // We do not assert success here.
        void r;
      }

      sandbox.resetToBaseline();

      const after = {
        products: await snapshotKeys(sandbox, 'products'),
        tags: await snapshotKeys(sandbox, 'tags'),
      };
      expect(after.products).toEqual(baselineKeys.products);
      expect(after.tags).toEqual(baselineKeys.tags);
    }
  );
});

// ─── Property: reset is idempotent ────────────────────────────────────────

describe('Sandbox — Property 5: reset is idempotent', () => {
  test.prop({ ops: dmlSequence(), n: fc.integer({ min: 2, max: 4 }) }, { numRuns: 15 })(
    'calling resetToBaseline n times equals calling it once',
    async ({ ops, n }) => {
      for (const op of ops) {
        await sandbox.exec(op, { allowDml: true });
      }
      for (let i = 0; i < n; i++) sandbox.resetToBaseline();

      const after = {
        products: await snapshotKeys(sandbox, 'products'),
        tags: await snapshotKeys(sandbox, 'tags'),
      };
      expect(after.products).toEqual(baselineKeys.products);
      expect(after.tags).toEqual(baselineKeys.tags);
    }
  );
});

// ─── Property: rejected DML does not leak state ───────────────────────────

describe('Sandbox — Property 5: rejected DML does not mutate database', () => {
  test.prop({ ops: dmlSequence() }, { numRuns: 15 })(
    'DML with allowDml=false is rejected and leaves baseline intact',
    async ({ ops }) => {
      // Always start clean.
      sandbox.resetToBaseline();

      for (const op of ops) {
        const r = await sandbox.exec(op, { allowDml: false });
        expect(r.kind).toBe('rejected_by_safety');
      }

      const after = {
        products: await snapshotKeys(sandbox, 'products'),
        tags: await snapshotKeys(sandbox, 'tags'),
      };
      expect(after.products).toEqual(baselineKeys.products);
      expect(after.tags).toEqual(baselineKeys.tags);
    }
  );
});

// ─── Example tests ────────────────────────────────────────────────────────

describe('Sandbox — examples', () => {
  it('SELECT returns columns and rows', async () => {
    sandbox.resetToBaseline();
    const r = await sandbox.exec('SELECT id, name FROM products ORDER BY id', {
      allowDml: false,
    });
    expect(r.kind).toBeUndefined();
    expect(r.columns).toEqual(['id', 'name']);
    expect(r.rows.length).toBe(5);
    expect(r.rows[0]).toEqual([1, 'Apple']);
  });

  it('safety filter rejects DROP', async () => {
    const r = await sandbox.exec('DROP TABLE products', { allowDml: true });
    expect(r.kind).toBe('rejected_by_safety');
  });

  it('safety filter rejects ALTER', async () => {
    const r = await sandbox.exec('ALTER TABLE products ADD COLUMN x INT', {
      allowDml: true,
    });
    expect(r.kind).toBe('rejected_by_safety');
  });

  it('INSERT succeeds with allowDml=true and is undone by reset', async () => {
    sandbox.resetToBaseline();
    const ins = await sandbox.exec(
      "INSERT INTO products (id, name, price) VALUES (99, 'Z', 7.0)",
      { allowDml: true }
    );
    expect(ins.kind).toBeUndefined();

    const after = await sandbox.exec('SELECT COUNT(*) FROM products', {
      allowDml: false,
    });
    expect(after.rows[0][0]).toBe(6);

    sandbox.resetToBaseline();
    const restored = await sandbox.exec('SELECT COUNT(*) FROM products', {
      allowDml: false,
    });
    expect(restored.rows[0][0]).toBe(5);
  });

  it('INSERT rejected with allowDml=false', async () => {
    const r = await sandbox.exec(
      "INSERT INTO products (id, name, price) VALUES (98, 'Y', 7.0)",
      { allowDml: false }
    );
    expect(r.kind).toBe('rejected_by_safety');
  });

  it('runtime error on unknown column is reported (not thrown)', async () => {
    const r = await sandbox.exec('SELECT no_such_col FROM products', {
      allowDml: false,
    });
    expect(r.kind).toBe('runtime');
    expect(typeof r.message).toBe('string');
  });

  it('describeSchema lists the loaded tables', () => {
    const tables = sandbox.describeSchema();
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['products', 'tags']);
    const products = tables.find((t) => t.name === 'products');
    expect(products.columns.map((c) => c.name)).toEqual(['id', 'name', 'price']);
    expect(products.primaryKey).toEqual(['id']);
  });

  it('row truncation flag is set when rowLimit is exceeded', async () => {
    sandbox.resetToBaseline();
    const r = await sandbox.exec('SELECT * FROM products', {
      allowDml: false,
      rowLimit: 2,
    });
    expect(r.kind).toBeUndefined();
    expect(r.rows.length).toBe(2);
    expect(r.truncated).toBe(true);
  });
});
