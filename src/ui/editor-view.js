// SQL editor view (R10.5 truncation surfaced via result-view, R18.3 format).
//
// A live syntax-highlighted editor (mirror + textarea pattern) plus the
// "格式化 SQL" / "提交" / "重置数据库" action buttons. Result rendering is
// delegated to result-view.js — this view only handles the *editor*
// portion of the page.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { parse } from '../sql/parser.js';
import { format } from '../sql/formatter.js';
import { createHighlightedEditor } from './sql-editor.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   onSubmit?: (sql: string) => void,
 *   onReset?: () => void,
 *   onChange?: (sql: string) => void,
 * }} deps
 */
export function createEditorView({ root, onSubmit, onReset, onChange } = {}) {
  let sql = '';
  let busy = false;
  /** @type {Array<any> | null} Schema (table+columns) used by CodeMirror's
   *  SQL autocompletion. Null when no DB is loaded — completion just won't
   *  suggest column names. */
  let schema = null;
  /** @type {ReturnType<typeof createHighlightedEditor> | null} */
  let editor = null;
  /** @type {HTMLButtonElement | null} */ let submitBtn = null;

  function render() {
    clear(root);

    const editorMount = el('div', { class: 'sql-editor-host' });
    submitBtn = /** @type {HTMLButtonElement} */ (el(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        'data-action': 'submit',
        disabled: busy ? true : undefined,
        onClick: () => { sql = editor?.getSql() ?? ''; onSubmit?.(sql); },
      },
      ZH.practice.submit,
    ));

    const actions = el('div', { class: 'editor-actions' },
      el(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-action': 'format-sql',
          onClick: () => {
            const current = editor?.getSql() ?? '';
            const ast = parse(current);
            if (!ast || ast.error) return;
            const formatted = format(ast);
            editor?.setSql(formatted);
            sql = formatted;
            onChange?.(sql);
          },
        },
        ZH.practice.formatSql,
      ),
      submitBtn,
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn-danger',
          'data-action': 'reset-db',
          onClick: () => onReset?.(),
        },
        ZH.practice.reset,
      ),
    );

    root.appendChild(el('section', { class: 'editor-view' }, editorMount, actions));

    editor = createHighlightedEditor({
      root: editorMount,
      placeholder: '在此输入 SQL……',
      onChange: (next) => { sql = next; onChange?.(next); },
    });
    editor.mount({ sql, schema });
  }

  return {
    mount(props = {}) {
      sql = props.sql ?? '';
      busy = Boolean(props.busy);
      if (props.schema !== undefined) schema = props.schema;
      render();
    },
    update(props = {}) {
      if (props.sql !== undefined && props.sql !== sql) {
        sql = props.sql;
        editor?.update({ sql });
      }
      if (props.schema !== undefined && props.schema !== schema) {
        schema = props.schema;
        editor?.update({ schema });
      }
      if (props.busy !== undefined) {
        busy = Boolean(props.busy);
        // Toggle the submit button's disabled state in place — avoid a
        // full re-render so the user's caret/selection survive.
        if (submitBtn) {
          if (busy) submitBtn.setAttribute('disabled', '');
          else submitBtn.removeAttribute('disabled');
        }
      }
    },
    getSql() { return sql; },
    unmount() { clear(root); editor = null; submitBtn = null; },
  };
}

export default createEditorView;
