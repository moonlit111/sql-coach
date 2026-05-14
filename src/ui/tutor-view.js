// Tutor view (R13.1, R13.4, R13.6).
//
// Renders a threaded chat view bound to `state.tutorThread`. The "显示参考
// 答案" button reveals `refSql` only on click (R13.6). Composer is disabled
// while a turn is in flight.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   onSend?: (msg: string) => void,
 * }} deps
 */
export function createTutorView({ root, onSend } = {}) {
  let local = {
    /** @type {Array<{ role: 'user'|'assistant', content: string, at?: number }>} */ thread: [],
    /** @type {boolean} */ awaitingReply: false,
    /** @type {string} */ refSql: '',
    /** @type {boolean} */ refRevealed: false,
    /** @type {string} */ draft: '',
  };

  function render() {
    clear(root);

    const thread = el(
      'ol',
      { class: 'tutor-thread', 'data-tutor-thread': '' },
      ...local.thread.map((m) =>
        el(
          'li',
          { class: `tutor-msg tutor-${m.role}`, 'data-role': m.role },
          el('div', { class: 'tutor-content' }, m.content),
        ),
      ),
      local.awaitingReply
        ? el('li', { class: 'tutor-pending', 'data-pending': '' }, ZH.tutor.thinking)
        : null,
    );

    const ta = el('textarea', {
      class: 'tutor-composer',
      rows: 3,
      placeholder: ZH.tutor.placeholder,
      disabled: local.awaitingReply ? true : undefined,
      'data-field': 'tutor-input',
      onInput: (ev) => { local.draft = ev.target.value; },
    });
    ta.value = local.draft;

    const sendBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        'data-action': 'tutor-send',
        disabled: local.awaitingReply ? true : undefined,
        onClick: () => {
          const txt = local.draft.trim();
          if (!txt) return;
          onSend?.(txt);
          local.draft = '';
          render();
        },
      },
      ZH.tutor.send,
    );

    const showAnswerBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn',
        'data-action': 'show-answer',
        onClick: () => { local.refRevealed = true; render(); },
      },
      ZH.practice.showAnswer,
    );

    root.appendChild(
      el('section', { class: 'tutor-view' },
        el('h3', {}, ZH.tutor.title),
        thread,
        local.refRevealed
          ? el('pre', { class: 'tutor-refsql', 'data-ref-sql': '' }, local.refSql)
          : showAnswerBtn,
        el('div', { class: 'tutor-composer-row' }, ta, sendBtn),
      ),
    );
  }

  return {
    mount(props = {}) {
      local = {
        thread: props.thread ?? [],
        awaitingReply: Boolean(props.awaitingReply),
        refSql: props.refSql ?? '',
        refRevealed: Boolean(props.refRevealed),
        draft: '',
      };
      render();
    },
    update(props = {}) {
      if (props.thread !== undefined) local.thread = props.thread;
      if (props.awaitingReply !== undefined) local.awaitingReply = Boolean(props.awaitingReply);
      if (props.refSql !== undefined) local.refSql = props.refSql;
      if (props.refRevealed !== undefined) local.refRevealed = Boolean(props.refRevealed);
      render();
    },
    unmount() { clear(root); },
  };
}

export default createTutorView;
