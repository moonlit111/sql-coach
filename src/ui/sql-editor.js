// SQL editor — CodeMirror 6 powered.
//
// Why CodeMirror 6 instead of the previous textarea+mirror hand-roll:
//   - The hand-roll lacked column-name autocomplete, multi-cursor,
//     find/replace, bracket matching, persistent undo across formatting.
//     For a learning app where the schema is the user's working
//     vocabulary, autocomplete is genuinely useful.
//   - CodeMirror 6 is modular ESM (~250KB total via CDN, cached after
//     first load). It loads via `<script type="importmap">` so we keep
//     the project's "no bundler" rule (R4.3).
//
// Public API is unchanged so editor-view.js / dual-editor-view.js
// continue to work without changes:
//
//   const ed = createHighlightedEditor({ root, placeholder, onChange, onKeyDown, schema });
//   ed.mount({ sql, schema });   // schema is optional
//   ed.update({ sql, schema });
//   ed.getSql() / ed.setSql() / ed.focus() / ed.unmount();
//
// The optional `schema` prop wires column-name autocomplete: pass
// `{ tableName: ['col1', 'col2', ...], ... }` and CodeMirror will
// suggest tables and columns as the user types.

import { EditorState } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, placeholder as placeholderExt,
} from '@codemirror/view';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput,
  foldGutter, foldKeymap,
} from '@codemirror/language';
import { sql, SQLite } from '@codemirror/lang-sql';
import { autocompletion, completionKeymap, acceptCompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

import { clear } from './dom.js';

// ── Curated SQL keyword list ───────────────────────────────────────
// We REPLACE lang-sql's default keyword completions (which dump 200+
// SQLite-specific tokens like PRAGMA / WITHOUT / COLLATE / JULIANDAY
// into the popup) with a focused set covering the topics this app
// actually teaches. Three benefits:
//   1) suggestions stay short and relevant to the curriculum
//   2) the list never includes SQL the project rejects (e.g. PRAGMA)
//   3) schema-derived names rank higher because they're not buried
//      under hundreds of irrelevant keywords
// Roughly ordered by typical query position so common matches surface
// first. The completion engine still does its own substring filter.
const CURATED_SQL_KEYWORDS = [
  // top-level statements
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT',
  'OFFSET', 'WITH',
  // joins
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN', 'RIGHT JOIN',
  'FULL JOIN', 'CROSS JOIN', 'ON', 'USING',
  // selectors
  'DISTINCT', 'AS', 'ALL',
  // predicates
  'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
  'EXISTS', 'NOT EXISTS', 'ANY', 'SOME',
  // aggregations
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  // control flow
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  // sort direction
  'ASC', 'DESC',
  // set ops (project teaches all three; EXCEPT is L3 emphasis)
  'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
  // literals
  'NULL', 'TRUE', 'FALSE',
];

/** Stash the most recently provided schema map so the completion source
 *  (which is registered ONCE at editor construction) can read fresh
 *  values after a schema reconfigure. The Compartment swap below keeps
 *  the source registered; this closure-captured ref keeps the data
 *  fresh without rebuilding the editor. */
let activeSchemaMap = null;

/** Build a completion source that only emits curated keywords + the
 *  current schema's tables and columns. Replaces lang-sql's defaults.
 *
 *  Context handling:
 *   - When the user just typed `tbl.`, only that table's columns are
 *     suggested (covers `users.<TAB>` and `u.<TAB>` after `FROM users u`).
 *   - In other positions, all tables + a flat union of all columns +
 *     the curated keyword list are suggested.
 *
 *  We deliberately avoid CodeMirror's `completeFromList` helper because
 *  it can't merge the keyword list with a context-sensitive lookup in
 *  one source — pulling completions ourselves is ~30 lines and gives
 *  us the precise filter the user asked for.
 */
function curatedCompletionSource(context) {
  // Try a `tbl.` (or alias.) prefix first — if matched we narrow to
  // that table's columns and bail out before adding any keywords.
  const beforeDot = context.matchBefore(/(\w+)\.\w*/);
  if (beforeDot) {
    const m = /^(\w+)\.(\w*)$/.exec(beforeDot.text);
    if (m) {
      const tblOrAlias = m[1];
      const partial    = m[2];
      const cols = resolveTableColumns(tblOrAlias, context);
      if (cols && cols.length > 0) {
        // Note: `from` is the start of the COLUMN segment, not the
        // whole match — otherwise we'd overwrite the table prefix.
        return {
          from:    beforeDot.from + tblOrAlias.length + 1,
          to:      context.pos,
          options: cols.map((c) => ({ label: c, type: 'property' })),
          // Allow CodeMirror to filter further by `partial`.
          validFor: /^\w*$/,
        };
      }
    }
  }

  const word = context.matchBefore(/\w*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  const tables = activeSchemaMap ? Object.keys(activeSchemaMap) : [];
  const allCols = activeSchemaMap
    ? [...new Set(Object.values(activeSchemaMap).flat())]
    : [];

  /** @type {Array<{label: string, type: string, boost?: number}>} */
  const options = [];
  for (const t of tables)   options.push({ label: t, type: 'class',    boost: 5 });
  for (const c of allCols)  options.push({ label: c, type: 'property', boost: 3 });
  for (const k of CURATED_SQL_KEYWORDS) options.push({ label: k, type: 'keyword' });

  return {
    from: word.from,
    options,
    validFor: /^\w*$/,
  };
}

/** Resolve a table name OR alias to its column list. Aliases are
 *  detected by scanning the visible document for `FROM <table> <alias>`
 *  or `JOIN <table> <alias>` (with optional AS). Falls back to a direct
 *  table-name lookup. */
function resolveTableColumns(nameOrAlias, context) {
  if (!activeSchemaMap) return null;
  // Direct hit?
  if (activeSchemaMap[nameOrAlias]) return activeSchemaMap[nameOrAlias];
  // Otherwise search for an alias binding in the document.
  // Pattern matches: FROM tbl AS alias / FROM tbl alias / JOIN tbl alias
  const text = context.state.doc.toString();
  const re = new RegExp(`\\b(?:FROM|JOIN)\\s+(\\w+)(?:\\s+AS)?\\s+${nameOrAlias}\\b`, 'i');
  const m = re.exec(text);
  if (m && activeSchemaMap[m[1]]) return activeSchemaMap[m[1]];
  return null;
}

// ── Project palette → CodeMirror highlight style ───────────────────
// These map onto the same tokens our older hand-rolled highlighter used
// (sql-highlight.js) so the visual identity stays consistent across the
// editor and the static "查看参考答案" / history blocks.
const SQL_HIGHLIGHT = HighlightStyle.define([
  { tag: t.keyword,           color: 'var(--magenta)', fontWeight: '600' },
  { tag: t.controlKeyword,    color: 'var(--magenta)', fontWeight: '600' },
  { tag: t.operatorKeyword,   color: 'var(--magenta)', fontWeight: '600' },
  { tag: t.string,            color: 'var(--warn)' },
  { tag: t.number,            color: 'var(--info)' },
  { tag: t.bool,              color: 'var(--info)' },
  { tag: t.null,              color: 'var(--info)' },
  { tag: t.comment,           color: 'var(--tx-3)', fontStyle: 'italic' },
  { tag: t.lineComment,       color: 'var(--tx-3)', fontStyle: 'italic' },
  { tag: t.blockComment,      color: 'var(--tx-3)', fontStyle: 'italic' },
  { tag: [t.operator, t.compareOperator, t.logicOperator, t.arithmeticOperator],
                              color: 'var(--accent)' },
  { tag: t.punctuation,       color: 'var(--tx-2)' },
  { tag: [t.bracket, t.paren, t.squareBracket, t.brace], color: 'var(--tx-2)' },
  { tag: t.variableName,      color: 'var(--tx)' },
  { tag: t.typeName,          color: 'var(--accent)' },
  { tag: t.atom,              color: 'var(--info)' },
]);

// CodeMirror's `EditorView.theme` lets us override the editor's own DOM
// styling without touching CodeMirror internals. We tune background,
// gutter, cursor, selection, and active-line to match the project's
// dark terminal look. CSS classes like `.cm-content` are stable per
// CodeMirror's docs.
const EDITOR_THEME = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--fs-base)',
    fontFamily: 'var(--mono)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--tx)',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '8px 0',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--tx-3)',
    border: 'none',
    borderRight: '1px solid var(--br)',
    fontSize: 'var(--fs-xxs)',
    paddingRight: '6px',
    userSelect: 'none',
  },
  '.cm-gutterElement': {
    paddingLeft: '8px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--accent-bg)',
    color: 'var(--accent)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  // The selection layer uses .cm-selectionBackground inside .cm-line
  // when drawSelection() is enabled (we enable it for cross-browser
  // consistency). Both selectors must be styled.
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-bg)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(166, 227, 161, 0.10)',
    outline: '1px solid var(--accent-dim)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-panel)',
    border: '1px solid var(--br-strong)',
    borderRadius: 'var(--r)',
    color: 'var(--tx)',
    fontSize: 'var(--fs-sm)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-bg)',
    color: 'var(--accent)',
  },
  '.cm-tooltip-autocomplete .cm-completionLabel': {
    fontFamily: 'var(--mono)',
  },
  '.cm-tooltip-autocomplete .cm-completionDetail': {
    color: 'var(--tx-3)',
    fontStyle: 'normal',
    marginLeft: '8px',
  },
  '.cm-placeholder': {
    color: 'var(--tx-mute)',
    fontStyle: 'italic',
  },
}, { dark: true });

/**
 * Convert our schemaSummary shape (`[{name, columns:[{name,...}]}]`)
 * into the `{ tableName: ['col1', 'col2'] }` map that
 * `@codemirror/lang-sql`'s `schema` option expects. Returns null when
 * the input has no usable tables — the caller passes null to skip
 * autocomplete configuration entirely.
 *
 * @param {Array<{ name: string, columns?: Array<{ name: string }> }> | null | undefined} schemaSummary
 * @returns {Record<string, string[]> | null}
 */
export function schemaToCompletionMap(schemaSummary) {
  if (!Array.isArray(schemaSummary) || schemaSummary.length === 0) return null;
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const t of schemaSummary) {
    if (!t || typeof t.name !== 'string') continue;
    const cols = Array.isArray(t.columns) ? t.columns : [];
    out[t.name] = cols
      .filter((c) => c && typeof c.name === 'string')
      .map((c) => c.name);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * @param {{
 *   root: HTMLElement,
 *   placeholder?: string,
 *   onChange?: (sql: string) => void,
 *   onKeyDown?: (ev: KeyboardEvent, getSql: () => string, setSql: (s: string) => void) => void,
 *   schema?: Array<{ name: string, columns?: Array<{ name: string }> }> | Record<string, string[]> | null,
 * }} deps
 */
export function createHighlightedEditor(deps = {}) {
  const { root, placeholder, onChange, onKeyDown, schema } = deps;

  /** @type {EditorView | null} */
  let view = null;

  /** Update the closure-captured schema map that drives the completion
   *  source. Called from {mount, update} so a database switch refreshes
   *  the suggestion list without rebuilding the editor. */
  function setSchemaMap(s) {
    const map = Array.isArray(s) ? schemaToCompletionMap(s)
              : (s && typeof s === 'object' ? s : null);
    activeSchemaMap = map;
  }

  function buildState(initialSql, initialSchema) {
    setSchemaMap(initialSchema);
    return EditorState.create({
      doc: initialSql ?? '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({
          activateOnTyping: true,
          icons: false,
          maxRenderedOptions: 12,
          // `override` REPLACES every other completion source (including
          // lang-sql's noisy 200+ keyword/function dump). The curated
          // source below emits only project-relevant SQL keywords and
          // schema-derived names — exactly the request from the user.
          override: [curatedCompletionSource],
        }),
        highlightActiveLine(),
        highlightSelectionMatches(),
        placeholder ? placeholderExt(placeholder) : [],
        // sql() still gives us highlighting / indentation / fold / bracket
        // matching from the SQLite grammar. We deliberately do NOT pass
        // `schema` here — the curated completion source above is the
        // single source of truth for suggestions.
        sql({ dialect: SQLite, upperCaseKeywords: true }),
        syntaxHighlighting(SQL_HIGHLIGHT),
        keymap.of([
          ...closeBracketsKeymap,
          // Tab → accept completion if popup is open; falls through to
          // indentWithTab below when no completion is active. Putting
          // it FIRST means popup-open ⇒ accept always wins. Returning
          // false from acceptCompletion (no popup) lets the next Tab
          // binding (indentWithTab) handle the indent.
          { key: 'Tab', run: acceptCompletion },
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...searchKeymap,
          indentWithTab,            // Tab inserts indent (only when no popup)
        ]),
        EDITOR_THEME,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            onChange?.(u.state.doc.toString());
          }
        }),
        // Forward keydown to the host so callers like dual-editor-view
        // can bind Cmd/Ctrl+Enter → submit. We keep this last so
        // CodeMirror's own keymap fires first (e.g. Tab indent).
        onKeyDown
          ? EditorView.domEventHandlers({
              keydown(ev, v) {
                onKeyDown(ev, () => v.state.doc.toString(), (next) => {
                  v.dispatch({
                    changes: { from: 0, to: v.state.doc.length, insert: String(next ?? '') },
                  });
                });
              },
            })
          : [],
      ],
    });
  }

  function mountInternal(initialSql, initialSchema) {
    clear(root);
    // Keep the legacy wrapper class so the existing flex-fill CSS in
    // .practice-main .editor-view > .sql-editor-host > .sql-editor-wrap
    // continues to size the editor without changes.
    const wrap = document.createElement('div');
    wrap.className = 'sql-editor-wrap';
    root.appendChild(wrap);
    view = new EditorView({
      state: buildState(initialSql, initialSchema),
      parent: wrap,
    });
  }

  return {
    mount(props = {}) {
      mountInternal(props.sql ?? '', props.schema ?? schema ?? null);
    },
    update(props = {}) {
      if (!view) return;
      if (props.sql !== undefined) {
        const cur = view.state.doc.toString();
        if (props.sql !== cur) {
          view.dispatch({
            changes: { from: 0, to: cur.length, insert: String(props.sql ?? '') },
          });
        }
      }
      if (props.schema !== undefined) {
        // Schema swap = update the closure-captured map only. The
        // completion source reads it on every keystroke, so the next
        // popup picks up the new tables/columns. No editor rebuild
        // and no Compartment reconfigure needed.
        setSchemaMap(props.schema);
      }
    },
    getSql() { return view ? view.state.doc.toString() : ''; },
    setSql(s) {
      if (!view) return;
      const cur = view.state.doc.toString();
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: String(s ?? '') },
      });
    },
    focus() { view?.focus(); },
    unmount() {
      if (view) { view.destroy(); view = null; }
      clear(root);
    },
  };
}

export default createHighlightedEditor;
