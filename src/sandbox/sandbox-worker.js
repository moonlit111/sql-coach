// Web Worker entry — runs sql.js inside a worker so the main thread can
// `worker.terminate()` to enforce a hard 5-second interruption (R10.2 /
// R11.3). The main-thread wrapper in `sandbox.js` is responsible for
// arming the timer and respawning the worker after a kill.
//
// Message protocol (all messages carry an `id` for correlation):
//   { id, type: 'init',       payload: { opts } }
//   { id, type: 'loadSchema', payload: { ddl, seedSql } }
//   { id, type: 'restore',    payload: { bytes } }
//   { id, type: 'exec',       payload: { sql, allowDml, rowLimit } }
//
// Responses:
//   { id, type: 'ok' }
//   { id, type: 'result', result: ResultSet | SqlError }
//   { id, type: 'error',  error: string }
//
// sql.js is loaded via importScripts so we get the same UMD factory
// (`globalThis.initSqlJs`) the main thread uses. We avoid `import` here
// because not all CDN ESM bundles cooperate when the source code does
// runtime Node-feature detection (esm.sh injects a Node shim that breaks
// Emscripten; jsdelivr `+esm` does not export the factory as default).

import { safetyFilter } from './safety-filter.js';

// Pull in sql.js as a side-effecting UMD that sets `self.initSqlJs`.
// This works in both classic and module workers (importScripts is
// allowed in classic; module workers we should avoid in production).
// In tests/node we never instantiate this worker — the in-process
// backend is used instead.
if (typeof self.initSqlJs !== 'function') {
  try {
    // eslint-disable-next-line no-undef
    importScripts('https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.js');
  } catch (e) {
    // If we're in a `type: 'module'` worker, importScripts won't be
    // available. Fall back to a dynamic import of the same UMD; it will
    // execute and assign `self.initSqlJs` as a side effect.
    await import('https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.js');
  }
}
const initSqlJsFactory = self.initSqlJs;
if (typeof initSqlJsFactory !== 'function') {
  throw new Error('sql.js worker factory was not initialised');
}

let SQL = null;
let db = null;

self.addEventListener('message', async (ev) => {
  const { type, id, payload } = ev.data || {};
  try {
    if (type === 'init') {
      if (!SQL) SQL = await initSqlJsFactory(payload?.opts || {});
      self.postMessage({ id, type: 'ok' });
      return;
    }

    if (type === 'loadSchema') {
      const { ddl, seedSql } = payload;
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      db = new SQL.Database();
      db.exec(ddl);
      if (seedSql) db.exec(seedSql);
      self.postMessage({ id, type: 'ok' });
      return;
    }

    if (type === 'restore') {
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      db = new SQL.Database(payload.bytes);
      self.postMessage({ id, type: 'ok' });
      return;
    }

    if (type === 'exec') {
      const { sql, allowDml, rowLimit = 10000 } = payload;
      const filt = safetyFilter(sql, { allowDml });
      if (!filt.ok) {
        self.postMessage({
          id,
          type: 'result',
          result: {
            kind: 'rejected_by_safety',
            message: filt.reason || 'rejected by safety filter',
          },
        });
        return;
      }
      try {
        const results = db.exec(sql);
        if (!results || results.length === 0) {
          self.postMessage({
            id,
            type: 'result',
            result: { columns: [], rows: [] },
          });
          return;
        }
        const last = results[results.length - 1];
        let rows = last.values || [];
        let truncated = false;
        if (rows.length > rowLimit) {
          rows = rows.slice(0, rowLimit);
          truncated = true;
        }
        self.postMessage({
          id,
          type: 'result',
          result: { columns: last.columns || [], rows, truncated },
        });
      } catch (e) {
        self.postMessage({
          id,
          type: 'result',
          result: { kind: 'runtime', message: String((e && e.message) || e) },
        });
      }
      return;
    }

    self.postMessage({ id, type: 'error', error: `unknown message: ${type}` });
  } catch (e) {
    self.postMessage({
      id,
      type: 'error',
      error: String((e && e.message) || e),
    });
  }
});
