// Dual editor view (R9.6 / R12.8 / Default D-D).
//
// When the active question's topics include `set_vs_join_compare`, render
// two side-by-side textareas labelled "集合查询写法" and "连接查询写法".
// The submit button passes BOTH `userSql` (set query) and `userSqlAlt`
// (join query) to the Judge node.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   onSubmit?: (userSql: string, userSqlAlt: string) => void,
 *   onReset?: () => void,
 * }} deps
 */
export function createDualEditorView({ root, onSubmit, onReset } = {}) {
  let local = {
    sqlSet: '',
    sqlJoin: '',
    busy: false,
  };

  function render() {
    clear(root);

    const setTa = el('textarea', {
      class: 'sql-editor sql-editor-set',
      'data-field': 'userSql',
      rows: 8,
      placeholder: '集合查询写法（UNION / INTERSECT / EXCEPT）',
      onInput: (ev) => { local.sqlSet = ev.target.value; },
    });
    setTa.value = local.sqlSet;

    const joinTa = el('textarea', {
      class: 'sql-editor sql-editor-join',
      'data-field': 'userSqlAlt',
      rows: 8,
      placeholder: '连接查询写法（JOIN / 子查询）',
      onInput: (ev) => { local.sqlJoin = ev.target.value; },
    });
    joinTa.value = local.sqlJoin;

    root.appendChild(
      el('section', { class: 'dual-editor-view' },
        el('div', { class: 'dual-grid' },
          el('div', { class: 'dual-pane' },
            el('h4', {}, '集合查询写法'),
            setTa,
          ),
          el('div', { class: 'dual-pane' },
            el('h4', {}, '连接查询写法'),
            joinTa,
          ),
        ),
        el('div', { class: 'editor-actions' },
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary',
              'data-action': 'submit-dual',
              disabled: local.busy ? true : undefined,
              onClick: () => onSubmit?.(setTa.value, joinTa.value),
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
      local.sqlSet = props.userSql ?? '';
      local.sqlJoin = props.userSqlAlt ?? '';
      local.busy = Boolean(props.busy);
      render();
    },
    update(props = {}) {
      if (props.userSql !== undefined) local.sqlSet = props.userSql;
      if (props.userSqlAlt !== undefined) local.sqlJoin = props.userSqlAlt;
      if (props.busy !== undefined) local.busy = Boolean(props.busy);
      render();
    },
    unmount() { clear(root); },
  };
}

export default createDualEditorView;
