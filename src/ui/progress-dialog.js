// Progress dialog — shows step-by-step status during long-running agent
// runs (SchemaGen, QuestionGen, Reporter).
//
// Why this file:
//   - Schema/question generation can take 5–30s and may retry up to 3
//     times. Without visible progress users assume the app is hung and
//     report "no feedback" bugs.
//   - This dialog renders a small list of steps with their state
//     (pending / running / ok / fail) plus the latest detail line. It is
//     fully render-only: callers push step updates via `update()`.
//
// Usage:
//   const dlg = createProgressDialog({ root, title: '正在生成数据库…' });
//   dlg.update({ steps: [
//     { id: 'llm',     label: '调用模型生成 DDL', status: 'running' },
//     { id: 'parse',   label: '解析 JSON',        status: 'pending' },
//     { id: 'sandbox', label: '在沙箱中执行',     status: 'pending' },
//     { id: 'verify',  label: '后置校验',         status: 'pending' },
//   ]});
//   ...
//   dlg.close();

import { el, clear } from './dom.js';

/**
 * @typedef {'pending'|'running'|'ok'|'fail'} StepStatus
 *
 * @typedef {Object} ProgressStep
 * @property {string} id
 * @property {string} label
 * @property {StepStatus} status
 * @property {string} [detail]   Optional one-liner shown under the label
 *
 * @typedef {Object} ProgressAction
 * @property {string} label                          Button text
 * @property {() => void} onClick                    Invoked on click
 * @property {('primary'|'default')} [variant]       Visual emphasis. Defaults 'default'.
 */

const STATUS_GLYPH = Object.freeze({
  pending: '○',
  running: '◐',
  ok:      '●',
  fail:    '✕',
});

/**
 * @param {{
 *   root: HTMLElement,
 *   title?: string,
 *   onClose?: () => void,
 * }} deps
 */
export function createProgressDialog({ root, title = '处理中…', onClose } = {}) {
  let local = {
    title,
    /** @type {ProgressStep[]} */
    steps: [],
    /** @type {string | null} */
    finalMessage: null,
    /** Optional action buttons rendered alongside the close button when
     *  the dialog is in the 'error' state. Used by main.js to surface
     *  targeted recovery options (switch DB, reduce topics, etc.). */
    /** @type {ProgressAction[]} */
    actions: [],
    /** @type {'running'|'done'|'error'} */
    overall: 'running',
  };

  function render() {
    clear(root);
    const backdrop = el('div', { class: 'progress-backdrop', 'data-progress-dialog': '' },
      el('section', { class: 'progress-card', role: 'dialog', 'aria-modal': 'true' },
        el('header', { class: 'progress-header' },
          el('span', { class: 'progress-title' }, local.title),
          local.overall !== 'running'
            ? el('button', {
                type: 'button',
                class: 'btn btn-ghost',
                'data-action': 'close',
                onClick: () => { onClose?.(); clear(root); },
              }, '关闭')
            : null,
        ),
        el('ol', { class: 'progress-steps' },
          ...local.steps.map((s) =>
            el('li', { class: `progress-step progress-step-${s.status}`, 'data-step-id': s.id },
              el('span', { class: 'progress-glyph' }, STATUS_GLYPH[s.status] ?? '○'),
              el('div', { class: 'progress-step-body' },
                el('div', { class: 'progress-step-label' }, s.label),
                s.detail
                  ? el('div', { class: 'progress-step-detail' }, s.detail)
                  : null,
              ),
            ),
          ),
        ),
        local.finalMessage
          ? el('div',
              { class: `progress-final progress-final-${local.overall}` },
              local.finalMessage,
            )
          : null,
        // Action buttons (only meaningful in error state — succeed
        // auto-closes too fast to click). Each button closes the dialog
        // before invoking the handler so navigation/focus changes don't
        // race with a still-mounted modal backdrop.
        local.overall === 'error' && local.actions.length > 0
          ? el('div', { class: 'progress-actions', 'data-progress-actions': '' },
              ...local.actions.map((a) =>
                el('button', {
                  type: 'button',
                  class: 'btn ' + (a.variant === 'primary' ? 'btn-primary' : ''),
                  'data-action': 'progress-action',
                  onClick: () => {
                    clear(root);
                    try { a.onClick?.(); } catch (e) { /* never break the dialog tear-down */ console.error(e); }
                  },
                }, a.label),
              ),
            )
          : null,
      ),
    );
    root.appendChild(backdrop);
  }

  return {
    /** Update title, steps, or final message. Re-renders. */
    update(props = {}) {
      if (props.title !== undefined)        local.title = props.title;
      if (props.steps !== undefined)        local.steps = props.steps;
      if (props.finalMessage !== undefined) local.finalMessage = props.finalMessage;
      if (props.overall !== undefined)      local.overall = props.overall;
      render();
    },
    /** Mark the dialog as resolved (success). */
    succeed(msg = '完成') {
      local.overall = 'done';
      local.finalMessage = msg;
      render();
    },
    /** Mark the dialog as failed and show the user the diagnostic.
     *  Accepts either a plain string (legacy) or an object with an
     *  optional `actions` array for recovery affordances. */
    fail(msgOrOpts) {
      local.overall = 'error';
      if (typeof msgOrOpts === 'string' || msgOrOpts == null) {
        local.finalMessage = msgOrOpts ?? '';
        local.actions = [];
      } else {
        local.finalMessage = msgOrOpts.message ?? '';
        local.actions = Array.isArray(msgOrOpts.actions) ? msgOrOpts.actions : [];
      }
      render();
    },
    /** Force-close the dialog. */
    close() {
      clear(root);
    },
    /** First mount. */
    mount() { render(); },
  };
}

export default createProgressDialog;
