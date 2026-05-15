// Schema library — simple list adapter for sqlcoach.schema_library.v1.
//
// Stores multiple databases the user has generated or imported. The
// active database is tracked separately by `PersistKey.CURRENT_SCHEMA`
// (so the existing R15.3 boot-restore logic keeps working unchanged).
// The library acts as a "saved snapshots" sidecar.
//
// Record shape:
//   {
//     id:        string,    // 'lib-<timestamp>-<rand>'
//     name:      string,    // user-visible label
//     ddl:       string,
//     seedSql:   string,
//     tables:    TableSchema[],   // mirror of describeSchema()
//     createdAt: number,
//     source:    'generated' | 'imported',
//   }
//
// All persistence calls go through the singleton `store` so the in-memory
// fallback (R2.5) and quota detection (R15.6) come for free.

import { store } from './store.js';
import { PersistKey } from './schema.js';

/** @returns {Array<any>} */
export function loadLibrary() {
  const v = store.get(PersistKey.SCHEMA_LIBRARY);
  return Array.isArray(v) ? v : [];
}

/** Persist the entire library array. Returns the {ok, ...} outcome. */
export function saveLibrary(list) {
  return store.set(PersistKey.SCHEMA_LIBRARY, Array.isArray(list) ? list : []);
}

/**
 * Append a record to the library. Generates a unique id if none is given.
 * Returns the saved record (with id filled in) plus the store outcome.
 *
 * @param {{name?:string, ddl:string, seedSql:string, tables:any[], source?:'generated'|'imported'}} entry
 */
export function addToLibrary(entry) {
  const list = loadLibrary();
  const rec = {
    id: `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: entry.name || defaultName(entry),
    ddl: entry.ddl,
    seedSql: entry.seedSql,
    tables: entry.tables ?? [],
    createdAt: Date.now(),
    source: entry.source ?? 'generated',
  };
  list.push(rec);
  const outcome = saveLibrary(list);
  return { record: rec, outcome };
}

/**
 * Remove a record by id. Returns true if found.
 * @param {string} id
 */
export function removeFromLibrary(id) {
  const list = loadLibrary();
  const idx = list.findIndex((r) => r.id === id);
  if (idx < 0) return { removed: false, outcome: { ok: true } };
  list.splice(idx, 1);
  const outcome = saveLibrary(list);
  return { removed: true, outcome };
}

/**
 * Look up a record by id.
 * @param {string} id
 */
export function findInLibrary(id) {
  return loadLibrary().find((r) => r.id === id) ?? null;
}

/**
 * Heuristic to produce a default name when the caller doesn't supply one.
 */
function defaultName(entry) {
  const tableCount = entry.tables?.length ?? 0;
  const first = entry.tables?.[0]?.name ?? '';
  if (entry.source === 'imported') {
    return `导入 (${tableCount} 表${first ? '，含 ' + first : ''})`;
  }
  return `数据库 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
}

/**
 * Parse an imported .sql file into ddl + seedSql by splitting at the
 * first INSERT statement (case-insensitive, on a statement boundary).
 * Falls back to putting everything in `ddl` and leaving `seedSql` empty
 * when no INSERT is found.
 *
 * The split is approximate — if the file has DDL after INSERTs (rare),
 * the user can re-import and edit. We keep this in JS rather than
 * sending it to the LLM so imports don't burn tokens.
 *
 * @param {string} sql
 * @returns {{ ddl: string, seedSql: string }}
 */
export function splitDdlAndSeed(sql) {
  if (typeof sql !== 'string') return { ddl: '', seedSql: '' };
  // Strip comments to make the regex match more reliable. Keep the
  // original text for output by tracking the position separately.
  // We do a simple state-machine scan rather than full tokenisation
  // because the SQL is user-provided and may not strictly follow the
  // tokenizer's allowed character set.
  const len = sql.length;
  let i = 0;
  let inStr = null; // null | "'" | '"'
  let inLineCom = false;
  let inBlockCom = false;
  while (i < len) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineCom) {
      if (c === '\n') inLineCom = false;
      i++; continue;
    }
    if (inBlockCom) {
      if (c === '*' && next === '/') { inBlockCom = false; i += 2; continue; }
      i++; continue;
    }
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) { inStr = null; i++; continue; }
      i++; continue;
    }
    if (c === '-' && next === '-') { inLineCom = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlockCom = true; i += 2; continue; }
    if (c === "'" || c === '"') { inStr = c; i++; continue; }

    // Detect "INSERT" keyword at a statement boundary. A statement
    // boundary is BOF or the first non-whitespace after a `;`.
    if ((c === 'I' || c === 'i') && /^insert\b/i.test(sql.slice(i, i + 7))) {
      // Look back to see if we're at a boundary.
      let k = i - 1;
      while (k >= 0 && /\s/.test(sql[k])) k--;
      if (k < 0 || sql[k] === ';') {
        return {
          ddl: sql.slice(0, i).trim(),
          seedSql: sql.slice(i).trim(),
        };
      }
    }
    i++;
  }
  return { ddl: sql.trim(), seedSql: '' };
}
