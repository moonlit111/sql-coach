// SQL Sandbox — main-thread wrapper around sql.js.
//
// In production the heavy lifting runs inside `sandbox-worker.js` so the
// main thread can `worker.terminate()` once the 5s timer fires (R10.2 /
// R11.3). The same class also supports an in-process backend that runs
// sql.js directly on the calling thread; the in-process backend is what the
// jsdom test suite uses.
//
// Backend selection:
//   - explicit:  new Sandbox({ useWorker: false })  // in-process
//   - explicit:  new Sandbox({ useWorker: true })   // worker
//   - auto:      new Sandbox()                      // worker if available
//
// Snapshot semantics (R10.6, R11.4): `loadSchema` runs the DDL + seed once,
// captures `db.export()` as `baselineSnapshot`, and `resetToBaseline()`
// rebuilds the database from those bytes — O(1) reset regardless of how
// much DML was applied in-between.
//
// Validates: R10.1, R10.3, R10.4, R10.5, R10.6, R11.1, R11.2, R11.3, R11.4
//
// @typedef {import('../types.js').ResultSet} ResultSet
// @typedef {import('../types.js').SqlError} SqlError

import initSqlJs from 'sql.js';
import { safetyFilter } from './safety-filter.js';
import { withTimeout } from './timeout.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_ROW_LIMIT = 10000;

export class Sandbox {
  /**
   * @param {{
   *   useWorker?: boolean,
   *   sqlJsLocateFile?: (file: string) => string,
   *   workerUrl?: string | URL,
   * }} [opts]
   */
  constructor({ useWorker, sqlJsLocateFile, workerUrl } = {}) {
    if (useWorker === undefined) useWorker = detectWorkerSupport();
    this.useWorker = useWorker;
    this.locateFile = sqlJsLocateFile;
    this.workerUrl = workerUrl;

    /** @type {any} */ this.SQL = null;
    /** @type {any} */ this.db = null;
    /** @type {Uint8Array | null} */ this.baselineSnapshot = null;
    /** @type {Worker | null} */ this.worker = null;
    /** @type {Map<number, (msg: any) => void>} */ this._pending = new Map();
    this._nextId = 1;
  }

  /** Initialise sql.js (in-process backend). Idempotent. */
  async init() {
    if (this.SQL) return;
    // In the browser, the wasm file must be loaded from a known URL.
    // We default to jsdelivr unless the caller provides a custom locator
    // (e.g. tests resolving from node_modules).
    const defaultLocate = (file) =>
      `https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/${file}`;
    const initOpts = this.locateFile
      ? { locateFile: this.locateFile }
      : (typeof window !== 'undefined' ? { locateFile: defaultLocate } : {});
    this.SQL = await initSqlJs(initOpts);
  }

  /**
   * Load DDL + seed and capture the baseline snapshot.
   * @param {string} ddl
   * @param {string} seedSql
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async loadSchema(ddl, seedSql) {
    await this.init();
    try {
      if (this.db) {
        try {
          this.db.close();
        } catch {
          /* ignore */
        }
      }
      const db = new this.SQL.Database();
      db.exec(ddl);
      if (seedSql && seedSql.trim()) db.exec(seedSql);
      this.db = db;
      this.baselineSnapshot = db.export();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** @returns {Uint8Array} */
  exportSnapshot() {
    if (!this.db) throw new Error('Sandbox: no database loaded');
    return this.db.export();
  }

  /** @param {Uint8Array} bytes */
  restoreSnapshot(bytes) {
    if (!this.SQL) throw new Error('Sandbox: not initialised');
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
    }
    this.db = new this.SQL.Database(bytes);
  }

  /** Restore the database to the seeded baseline. Idempotent. */
  resetToBaseline() {
    if (!this.baselineSnapshot) throw new Error('Sandbox: no baseline snapshot');
    this.restoreSnapshot(this.baselineSnapshot);
  }

  /**
   * Execute SQL after running it through the safety filter.
   *
   * @param {string} sql
   * @param {{ allowDml?: boolean, timeoutMs?: number, rowLimit?: number }} [opts]
   * @returns {Promise<ResultSet | SqlError>}
   */
  async exec(
    sql,
    { allowDml = false, timeoutMs = DEFAULT_TIMEOUT_MS, rowLimit = DEFAULT_ROW_LIMIT } = {}
  ) {
    const filt = safetyFilter(sql, { allowDml });
    if (!filt.ok) {
      return {
        kind: 'rejected_by_safety',
        message: filt.reason || 'rejected by safety filter',
      };
    }
    if (!this.db && !this.useWorker) {
      return { kind: 'runtime', message: 'no database loaded' };
    }
    if (this.useWorker) {
      return this._execWorker(sql, { allowDml, rowLimit, timeoutMs });
    }
    return this._execInProcess(sql, { rowLimit, timeoutMs });
  }

  // ── In-process backend ────────────────────────────────────────────────

  /**
   * @param {string} sql
   * @param {{ rowLimit: number, timeoutMs: number }} opts
   * @returns {Promise<ResultSet | SqlError>}
   */
  _execInProcess(sql, { rowLimit, timeoutMs }) {
    // sql.js exec() is synchronous; the soft timeout cannot interrupt it,
    // but we still arm the timer so the caller's contract is satisfied
    // when the underlying engine somehow stalls (e.g. a broken locateFile
    // resolution forces a re-init on a subsequent call).
    const work = new Promise((resolve) => {
      try {
        const results = this.db.exec(sql);
        if (!results || results.length === 0) {
          resolve({ columns: [], rows: [] });
          return;
        }
        const last = results[results.length - 1];
        let rows = last.values || [];
        let truncated = false;
        if (rows.length > rowLimit) {
          rows = rows.slice(0, rowLimit);
          truncated = true;
        }
        resolve({ columns: last.columns || [], rows, truncated });
      } catch (e) {
        resolve({ kind: 'runtime', message: String((e && e.message) || e) });
      }
    });

    return withTimeout(work, timeoutMs, () => {
      // Best-effort recovery on timeout: restore the baseline so a stuck
      // statement does not leave the database in a half-mutated state.
      try {
        this.resetToBaseline();
      } catch {
        /* ignore */
      }
    }).catch((err) => {
      if (err && err.name === 'TimeoutError') {
        return { kind: 'timeout', message: 'SQL execution timeout' };
      }
      return { kind: 'runtime', message: String((err && err.message) || err) };
    });
  }

  // ── Worker backend ────────────────────────────────────────────────────

  async _ensureWorker() {
    if (this.worker) return;
    const url =
      this.workerUrl ||
      // eslint-disable-next-line no-undef
      new URL('./sandbox-worker.js', import.meta.url);
    this.worker = new Worker(url, { type: 'module' });
    this.worker.addEventListener('message', (ev) => {
      const { id } = ev.data || {};
      const cb = this._pending.get(id);
      if (cb) {
        this._pending.delete(id);
        cb(ev.data);
      }
    });
    await this._postToWorker({
      type: 'init',
      payload: { opts: this.locateFile ? { locateFile: this.locateFile } : {} },
    });
    if (this.baselineSnapshot) {
      await this._postToWorker({
        type: 'restore',
        payload: { bytes: this.baselineSnapshot },
      });
    }
  }

  /**
   * @param {{type: string, payload?: any}} msg
   * @returns {Promise<any>}
   */
  _postToWorker(msg) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, (data) => {
        if (data.type === 'error') reject(new Error(data.error));
        else resolve(data);
      });
      this.worker.postMessage({ id, ...msg });
    });
  }

  /**
   * @param {string} sql
   * @param {{ allowDml: boolean, rowLimit: number, timeoutMs: number }} opts
   * @returns {Promise<ResultSet | SqlError>}
   */
  async _execWorker(sql, { allowDml, rowLimit, timeoutMs }) {
    await this._ensureWorker();

    const work = this._postToWorker({
      type: 'exec',
      payload: { sql, allowDml, rowLimit },
    }).then((data) => data.result);

    return withTimeout(work, timeoutMs, () => {
      // Hard interrupt — terminate the worker, drop pending callbacks, and
      // respawn from baseline. This realises R10.2 / R11.3 even when sql.js
      // is mid-query.
      try {
        this.worker?.terminate();
      } catch {
        /* ignore */
      }
      this.worker = null;
      this._pending.clear();
    }).catch((err) => {
      if (err && err.name === 'TimeoutError') {
        return { kind: 'timeout', message: 'SQL execution timeout' };
      }
      return { kind: 'runtime', message: String((err && err.message) || err) };
    });
  }

  // ── Schema introspection ──────────────────────────────────────────────

  /**
   * Describe every user table in the current database.
   * @returns {Array<{ name: string, columns: any[], primaryKey: string[], foreignKeys: any[] }>}
   */
  describeSchema() {
    if (!this.db) return [];

    const tableRows = this.db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    if (!tableRows.length) return [];
    const names = tableRows[0].values.map((r) => r[0]);

    const tables = [];
    for (const name of names) {
      const info = this.db.exec(`PRAGMA table_info("${name}")`);
      const fkInfo = this.db.exec(`PRAGMA foreign_key_list("${name}")`);
      // PRAGMA table_info row: [cid, name, type, notnull, dflt_value, pk]
      const infoRows = info[0]?.values || [];
      const columns = infoRows.map((r) => ({
        name: r[1],
        type: r[2] || 'ANY',
        nullable: r[3] === 0,
        default: r[4] === null || r[4] === undefined ? undefined : r[4],
      }));
      const primaryKey = infoRows
        .filter((r) => r[5] > 0)
        .sort((a, b) => a[5] - b[5])
        .map((r) => r[1]);

      // PRAGMA foreign_key_list row: [id, seq, table, from, to, on_update, on_delete, match]
      const fkRows = fkInfo[0]?.values || [];
      /** @type {Map<number, { columns: string[], refTable: string, refColumns: string[] }>} */
      const fkGroups = new Map();
      for (const r of fkRows) {
        const id = r[0];
        let g = fkGroups.get(id);
        if (!g) {
          g = { columns: [], refTable: r[2], refColumns: [] };
          fkGroups.set(id, g);
        }
        g.columns.push(r[3]);
        g.refColumns.push(r[4]);
      }
      const foreignKeys = Array.from(fkGroups.values());

      tables.push({ name, columns, primaryKey, foreignKeys });
    }
    return tables;
  }

  /** Release resources. Safe to call repeatedly. */
  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
    }
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        /* ignore */
      }
      this.worker = null;
    }
    this._pending.clear();
    this.baselineSnapshot = null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function detectWorkerSupport() {
  try {
    return typeof Worker !== 'undefined' && typeof window !== 'undefined';
  } catch {
    return false;
  }
}
