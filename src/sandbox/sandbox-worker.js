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

import initSqlJs from 'sql.js';
import { safetyFilter } from './safety-filter.js';

let SQL = null;
let db = null;

self.addEventListener('message', async (ev) => {
  const { type, id, payload } = ev.data || {};
  try {
    if (type === 'init') {
      if (!SQL) SQL = await initSqlJs(payload?.opts || {});
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
