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

import { EditorState, Compartment } from '@codemirror/state';
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
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

import { clear } from './dom.js';

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
  /** Compartment lets us swap `sql({...})` config (e.g. when the user
   *  switches active database) without rebuilding the entire editor. */
  const sqlCompartment = new Compartment();

  function buildSqlExt(s) {
    const map = Array.isArray(s) ? schemaToCompletionMap(s)
              : (s && typeof s === 'object' ? s : null);
    return sql({
      dialect: SQLite,
      schema: map ?? undefined,
      upperCaseKeywords: true,
    });
  }

  function buildState(initialSql, initialSchema) {
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
        }),
        highlightActiveLine(),
        highlightSelectionMatches(),
        placeholder ? placeholderExt(placeholder) : [],
        sqlCompartment.of(buildSqlExt(initialSchema)),
        syntaxHighlighting(SQL_HIGHLIGHT),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...searchKeymap,
          indentWithTab,            // Tab inserts indent (not focus jump)
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
        view.dispatch({
          effects: sqlCompartment.reconfigure(buildSqlExt(props.schema)),
        });
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
