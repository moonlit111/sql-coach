// Dual editor view (R9.6 / R12.8 / Default D-D).
//
// When the active question's topics include `set_vs_join_compare`, render
// two side-by-side textareas labelled "集合查询写法" and "连接查询写法".
// The submit button passes BOTH `userSql` (set query) and `userSqlAlt`
// (join query) to the Judge node.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { createHighlightedEditor } from './sql-editor.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   onSubmit?: (userSql: string, userSqlAlt: string) => void,
 *   onReset?: () => void,
 *   onChange?: (userSql: string, userSqlAlt: string) => void,
 * }} deps
 */
export function createDualEditorView({ root, onSubmit, onReset, onChange } = {}) {
  let local = {
    sqlSet: '',
    sqlJoin: '',
    busy: false,
    /** @type {Array<any> | null} */ schema: null,
  };
  /** @type {ReturnType<typeof createHighlightedEditor> | null} */ let setEditor = null;
  /** @type {ReturnType<typeof createHighlightedEditor> | null} */ let joinEditor = null;
  /** @type {HTMLButtonElement | null} */ let submitBtn = null;

  function render() {
    clear(root);

    const setMount = el('div', { class: 'sql-editor-host' });
    const joinMount = el('div', { class: 'sql-editor-host' });

    const actions = el('div', { class: 'editor-actions' },
      submitBtn = /** @type {HTMLButtonElement} */ (el(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary',
          'data-action': 'submit-dual',
          disabled: local.busy ? true : undefined,
          onClick: () => onSubmit?.(setEditor?.getSql() ?? '', joinEditor?.getSql() ?? ''),
        },
        ZH.practice.submit,
      )),
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

    root.appendChild(
      el('section', { class: 'dual-editor-view' },
        el('div', { class: 'dual-grid' },
          el('div', { class: 'dual-pane' },
            el('h4', {}, '集合查询写法'),
            setMount,
          ),
          el('div', { class: 'dual-pane' },
            el('h4', {}, '连接查询写法'),
            joinMount,
          ),
        ),
        actions,
      ),
    );

    setEditor = createHighlightedEditor({
      root: setMount,
      placeholder: '集合查询写法（UNION / INTERSECT / EXCEPT）',
      onChange: (s) => { local.sqlSet = s; onChange?.(local.sqlSet, local.sqlJoin); },
    });
    setEditor.mount({ sql: local.sqlSet, schema: local.schema });

    joinEditor = createHighlightedEditor({
      root: joinMount,
      placeholder: '连接查询写法（JOIN / 子查询）',
      onChange: (s) => { local.sqlJoin = s; onChange?.(local.sqlSet, local.sqlJoin); },
    });
    joinEditor.mount({ sql: local.sqlJoin, schema: local.schema });
  }

  return {
    mount(props = {}) {
      local.sqlSet = props.userSql ?? '';
      local.sqlJoin = props.userSqlAlt ?? '';
      local.busy = Boolean(props.busy);
      if (props.schema !== undefined) local.schema = props.schema;
      render();
    },
    update(props = {}) {
      if (props.userSql !== undefined && props.userSql !== local.sqlSet) {
        local.sqlSet = props.userSql;
        setEditor?.update({ sql: local.sqlSet });
      }
      if (props.userSqlAlt !== undefined && props.userSqlAlt !== local.sqlJoin) {
        local.sqlJoin = props.userSqlAlt;
        joinEditor?.update({ sql: local.sqlJoin });
      }
      if (props.schema !== undefined && props.schema !== local.schema) {
        local.schema = props.schema;
        setEditor?.update({ schema: local.schema });
        joinEditor?.update({ schema: local.schema });
      }
      if (props.busy !== undefined) {
        local.busy = Boolean(props.busy);
        if (submitBtn) {
          if (local.busy) submitBtn.setAttribute('disabled', '');
          else submitBtn.removeAttribute('disabled');
        }
      }
    },
    unmount() { clear(root); setEditor = null; joinEditor = null; submitBtn = null; },
  };
}

export default createDualEditorView;
