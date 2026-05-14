// SQL editor view (R10.5 truncation surfaced via result-view, R18.3 format).
//
// A textarea + "格式化 SQL" button (calls formatter.format(parser.parse(sql)))
// + "提交" button + "重置数据库" button. Result rendering is delegated to
// result-view.js — this view only handles the *editor* portion of the page.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { parse } from '../sql/parser.js';
import { format } from '../sql/formatter.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   onSubmit?: (sql: string) => void,
 *   onReset?: () => void,
 * }} deps
 */
export function createEditorView({ root, onSubmit, onReset } = {}) {
  let sql = '';
  let busy = false;

  function render() {
    clear(root);
    const ta = el('textarea', {
      class: 'sql-editor',
      'data-field': 'userSql',
      rows: 8,
      placeholder: '在此输入 SQL……',
      onInput: (ev) => { sql = ev.target.value; },
    });
    ta.value = sql;

    root.appendChild(
      el('section', { class: 'editor-view' },
        ta,
        el('div', { class: 'editor-actions' },
          el(
            'button',
            {
              type: 'button',
              class: 'btn',
              'data-action': 'format-sql',
              onClick: () => {
                const ast = parse(ta.value);
                if (!ast || ast.error) return;
                const formatted = format(ast);
                sql = formatted;
                ta.value = formatted;
              },
            },
            ZH.practice.formatSql,
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary',
              'data-action': 'submit',
              disabled: busy ? true : undefined,
              onClick: () => { sql = ta.value; onSubmit?.(sql); },
            },
            ZH.practice.submit,
          ),
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
        ),
      ),
    );
  }

  return {
    mount(props = {}) {
      sql = props.sql ?? '';
      busy = Boolean(props.busy);
      render();
    },
    update(props = {}) {
      if (props.sql !== undefined) sql = props.sql;
      if (props.busy !== undefined) busy = Boolean(props.busy);
      render();
    },
    getSql() { return sql; },
    unmount() { clear(root); },
  };
}

export default createEditorView;
