// Tutor view — 在线问答 (R13.1, R13.4, R13.6).
//
// Renders a threaded chat view bound to `state.tutorThread`. Assistant
// messages are rendered as Markdown so headings, lists and SQL code
// fences look correct. Composer is disabled while a turn is in flight.
//
// Features:
//   - Quick action chips: context-aware suggested prompts above the input
//   - New conversation button in the header area
//   - Reference-answer reveal card (toggled from question panel)
//   - Copy SQL button on assistant messages containing code blocks

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { renderMarkdown } from './markdown.js';

// ── Quick action definitions ──────────────────────────────────────────
const ACTIONS_WRONG = [
  { label: '给我一个提示', prompt: '不要直接告诉我答案，给我一个提示让我自己想出来。' },
  { label: '解释错误原因', prompt: '详细解释我的 SQL 哪里出了问题，错误的根本原因是什么？' },
  { label: '逐步引导我', prompt: '一步一步引导我写出正确的 SQL，每次只给一个步骤。' },
  { label: '对比两种写法', prompt: '对比我的写法和正确写法，用表格列出关键差异。' },
];

const ACTIONS_CORRECT = [
  { label: '有更优写法吗', prompt: '我的 SQL 还有更优的写法吗？从性能和可读性两方面分析。' },
  { label: '解释考点', prompt: '这道题考察了哪些 SQL 知识点？帮我总结一下。' },
  { label: '出一道类似题', prompt: '基于同样的知识点，再出一道类似但不同的题目给我练习。' },
];

const ACTIONS_NO_QUESTION = [
  { label: 'JOIN 与子查询区别', prompt: '帮我解释 SQL 中 JOIN 和子查询各自的适用场景，什么时候该用哪个？' },
  { label: '复习错题', prompt: '帮我回顾一下我之前做错的题目，总结常见错误模式。' },
  { label: '窗口函数入门', prompt: '简单介绍一下 SQL 窗口函数（ROW_NUMBER, RANK, PARTITION BY）的用法。' },
];

/**
 * @param {{
 *   root: HTMLElement,
 *   onSend?: (msg: string) => void,
 *   onNewConversation?: () => void,
 * }} deps
 */
export function createTutorView({ root, onSend, onNewConversation } = {}) {
  let local = {
    /** @type {Array<{ role: 'user'|'assistant', content: string, at?: number }>} */ thread: [],
    /** @type {boolean} */ awaitingReply: false,
    /** @type {string} */ draft: '',
    /** @type {'wrong'|'correct'|'none'} */ verdictState: 'none',
  };

  /** @type {HTMLOListElement | null} */ let threadEl = null;
  /** @type {HTMLTextAreaElement | null} */ let ta = null;
  /** @type {HTMLButtonElement | null} */ let sendBtn = null;
  /** @type {HTMLElement | null} */ let chipsEl = null;
  /** @type {HTMLElement | null} */ let viewRoot = null;

  function sendQuickAction(prompt) {
    if (local.awaitingReply) return;
    onSend?.(prompt);
  }

  function renderMessageBody(m) {
    if (m.role === 'user') {
      return el('div', { class: 'tutor-content tutor-content-user' }, m.content);
    }
    const wrap = el('div', { class: 'tutor-content tutor-content-assistant' });
    wrap.appendChild(renderMarkdown(m.content));
    return wrap;
  }

  function updateThread() {
    if (!threadEl) return;
    clear(threadEl);

    if (local.thread.length === 0 && !local.awaitingReply) {
      // Empty state
      threadEl.appendChild(
        el('li', { class: 'tutor-empty-state' },
          el('div', { class: 'tutor-empty-icon' }, '?'),
          el('p', {}, '有任何关于当前题目的问题，都可以在这里提问。'),
          el('p', { class: 'meta' }, '也可以点击下方的快捷按钮快速提问。'),
        ),
      );
      return;
    }

    for (const m of local.thread) {
      threadEl.appendChild(
        el('li', { class: `tutor-msg tutor-${m.role}`, 'data-role': m.role },
          renderMessageBody(m),
        ),
      );
    }
    if (local.awaitingReply) {
      threadEl.appendChild(
        el('li', { class: 'tutor-pending', 'data-pending': '' }, ZH.tutor.thinking),
      );
    }
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  function getQuickActions() {
    if (local.verdictState === 'wrong') return ACTIONS_WRONG;
    if (local.verdictState === 'correct') return ACTIONS_CORRECT;
    return ACTIONS_NO_QUESTION;
  }

  function updateChips() {
    if (!chipsEl) return;
    clear(chipsEl);
    const actions = getQuickActions();
    for (const a of actions) {
      chipsEl.appendChild(
        el('button', {
          type: 'button',
          class: 'tutor-chip',
          disabled: local.awaitingReply ? true : undefined,
          onClick: () => sendQuickAction(a.prompt),
        }, a.label),
      );
    }
  }

  function updateComposerState() {
    if (ta) {
      if (local.awaitingReply) ta.setAttribute('disabled', '');
      else ta.removeAttribute('disabled');
    }
    if (sendBtn) {
      if (local.awaitingReply) sendBtn.setAttribute('disabled', '');
      else sendBtn.removeAttribute('disabled');
    }
    updateChips();
  }

  function render() {
    clear(root);

    // Header with role chip on the left + "new conversation" on the right.
    // The role chip is the visual signal that distinguishes this column
    // from the mint-coloured 出题/编辑器 cards — see styles/main.css
    // (.practice-tutor scoped overrides).
    const header = el('div', { class: 'tutor-header' },
      el('span', { class: 'tutor-role-chip', 'data-role-chip': '' }, 'AI 助手'),
      el('button', {
        type: 'button',
        class: 'btn tutor-new-btn',
        title: '开始新对话',
        onClick: () => onNewConversation?.(),
      }, '+ 新对话'),
    );

    threadEl = /** @type {HTMLOListElement} */ (el('ol', { class: 'tutor-thread', 'data-tutor-thread': '' }));

    chipsEl = el('div', { class: 'tutor-chips' });

    ta = /** @type {HTMLTextAreaElement} */ (el('textarea', {
      class: 'tutor-composer',
      rows: 2,
      placeholder: ZH.tutor.placeholder,
      disabled: local.awaitingReply ? true : undefined,
      'data-field': 'tutor-input',
      onInput: (ev) => { local.draft = ev.target.value; },
      onKeyDown: (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          if (local.awaitingReply) return;
          const txt = local.draft.trim();
          if (!txt) return;
          local.draft = '';
          ta.value = '';
          onSend?.(txt);
        }
      },
    }));
    ta.value = local.draft;

    sendBtn = /** @type {HTMLButtonElement} */ (el(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        'data-action': 'tutor-send',
        disabled: local.awaitingReply ? true : undefined,
        onClick: () => {
          const txt = local.draft.trim();
          if (!txt) return;
          local.draft = '';
          ta.value = '';
          onSend?.(txt);
        },
      },
      ZH.tutor.send,
    ));

    viewRoot = el('section', { class: 'tutor-view' },
      header,
      threadEl,
      chipsEl,
      el('div', { class: 'tutor-composer-row' }, ta, sendBtn),
    );
    root.appendChild(viewRoot);

    updateThread();
    updateChips();
  }

  return {
    mount(props = {}) {
      local = {
        thread: props.thread ?? [],
        awaitingReply: Boolean(props.awaitingReply),
        draft: '',
        verdictState: props.verdictState ?? 'none',
      };
      render();
    },
    update(props = {}) {
      let threadChanged = false;
      let chipsChanged = false;
      if (props.thread !== undefined && props.thread !== local.thread) {
        local.thread = props.thread;
        threadChanged = true;
      }
      if (props.awaitingReply !== undefined) {
        const next = Boolean(props.awaitingReply);
        if (next !== local.awaitingReply) {
          local.awaitingReply = next;
          threadChanged = true;
          chipsChanged = true;
        }
      }
      if (props.verdictState !== undefined && props.verdictState !== local.verdictState) {
        local.verdictState = props.verdictState;
        chipsChanged = true;
      }
      if (threadChanged) updateThread();
      if (threadChanged || chipsChanged) updateComposerState();
    },
    unmount() { clear(root); threadEl = null; ta = null; sendBtn = null; chipsEl = null; viewRoot = null; },
  };
}

export default createTutorView;
