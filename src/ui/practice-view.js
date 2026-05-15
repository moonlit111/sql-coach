// Practice view — three-column layout with collapsible Panels.
//
// Layout (May 2026 v6):
//   Left column   — 题目 / 出题
//   Center column — 编辑器 / 结果   (3:1 height ratio, fills viewport)
//   Right column  — 在线问答 (Tutor) (fills viewport, chat scrolls)
//
// Resizable column widths:
//   - Two vertical splitters between the columns let the user drag
//     columns horizontally. Widths are persisted to localStorage so they
//     survive a page reload.
//   - CSS variables `--col-side` / `--col-tutor` carry the current
//     widths; the grid template references them.
//
// Reference-answer reveal:
//   - The Tutor panel's header carries an extra "📜 参考答案" button.
//     Clicking it toggles a separate ref-card that lives between the
//     thread and the composer (handled by tutor-view.js).
//
// Database management lives in its own top-level tab — Practice never
// touches the library; it reads `activeDbId` only to gate "出题".

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { TOPICS } from '../data/topics.js';
import { DIFFICULTY_LEVELS } from '../types.js';
import { createPanel } from './panel.js';
import { createSplitter } from './splitter.js';
import { renderSqlAsNodes } from './sql-highlight.js';

// Default column widths (px). Min/Max clamps applied while dragging.
const COL_DEFAULTS = { side: 300, tutor: 380 };
const COL_MIN      = { side: 240, tutor: 280 };
const COL_MAX      = { side: 520, tutor: 600 };
// Default in-column row heights (px). Top row is draggable; bottom row
// fills the remainder via `minmax(0, 1fr)` in CSS. Values are clamped to
// these ranges while dragging and on initial load. Editor default is
// generous so the SQL textarea isn't cramped; users can drag down to
// give the result panel more room.
const ROW_DEFAULTS = { questionH: 220, editorH: 520 };
const ROW_MIN      = { questionH:  80, editorH: 200 };
const ROW_MAX      = { questionH: 800, editorH: 1400 };
const LAYOUT_KEY   = 'sqlcoach.practice_layout.v1';

/**
 * @param {{
 *   root: HTMLElement,
 *   dialogRoot?: HTMLElement,
 *   onStartQuestion?: (
 *     difficulty: 'L1'|'L2'|'L3'|'L4',
 *     topics: string[],
 *   ) => void,
 *   onCustomQuestion?: (customPrompt: string) => void,
 *   onGoToDatabaseTab?: () => void,
 *   onToggleRefSql?: (next: boolean) => void,
 *   onSelectHistoryQuestion?: (questionRecord: any) => void,
 *   getHistoryQuestions?: () => Array<any>,
 * }} deps
 */
export function createPracticeView(deps = {}) {
  const { root, dialogRoot, onStartQuestion, onCustomQuestion, onGoToDatabaseTab, onToggleRefSql, onSelectHistoryQuestion, getHistoryQuestions } = deps;

  // ── State ────────────────────────────────────────────────────────
  let local = {
    /** @type {'L1'|'L2'|'L3'|'L4'} */ difficulty: 'L1',
    /** @type {Set<string>} */ topics: new Set(['single_table_select']),
    /** @type {string | null} */ activeDbId: null,
    activeDbName: '',
    /** @type {import('../types.js').Question | null} */ question: null,
    /** Tutor's reference-answer reveal flag, mirrored here so the header
     *  button can show the right label. */
    refRevealed: false,
    /** Custom prompt text for free-form question generation. */
    customPrompt: '',
  };

  /** Persisted column widths. */
  let layout = loadLayout();

  /** @type {Record<string, ReturnType<typeof createPanel>>} */
  let panels = {};
  /** @type {HTMLElement | null} */ let practiceRoot = null;
  /** @type {ReturnType<typeof createSplitter>[]} */ let splitters = [];

  // ── Body builders ────────────────────────────────────────────────
  function buildQuestionGenBody() {
    const noActive = !local.activeDbId;
    const hasCustom = local.customPrompt.trim().length > 0;
    return el('div', { class: 'field-row qgen-body' },
      noActive
        ? el('div', { class: 'qgen-no-db' },
            el('p', { class: 'meta' }, '尚未选择活动数据库。'),
            el('button', {
              type: 'button',
              class: 'btn',
              'data-action': 'go-to-db-tab',
              onClick: () => onGoToDatabaseTab?.(),
            }, '前往「数据库」选择'),
          )
        : null,
      el('div', { class: 'compact-row' },
        ...DIFFICULTY_LEVELS.map((lvl) =>
          el('button', {
            type: 'button',
            class: 'diff-btn ' + (local.difficulty === lvl ? 'active' : ''),
            'data-difficulty': lvl,
            onClick: () => { local.difficulty = lvl; refreshBodies(); },
          },
            el('span', { class: 'diff-level' }, lvl),
            el('span', { class: 'diff-label' }, ZH.practice.difficulty[lvl]),
          ),
        ),
      ),
      el('p', { class: 'diff-hint' }, ZH.practice.difficulty[local.difficulty]),
      el('div', { class: 'topic-chips-list' },
        ...TOPICS.map((t) =>
          el('label',
            { class: 'chip ' + (local.topics.has(t.id) ? 'chip-selected' : ''), 'data-topic': t.id },
            el('input', {
              type: 'checkbox', name: 'topic', value: t.id,
              checked: local.topics.has(t.id) ? true : undefined,
              onChange: () => {
                if (local.topics.has(t.id)) local.topics.delete(t.id);
                else local.topics.add(t.id);
                refreshBodies();
              },
            }),
            t.zh,
          ),
        ),
      ),
      // Custom prompt textarea — above the submit button
      el('textarea', {
        class: 'qgen-custom-input',
        rows: 2,
        placeholder: '自定义要求（可选）：如"出一道 LEFT JOIN + 子查询的题"',
        value: local.customPrompt,
        onInput: (ev) => { local.customPrompt = ev.target.value; },
      }),
      // Single submit button — uses custom prompt when filled
      el('button', {
        type: 'button',
        class: 'btn btn-primary',
        'data-action': 'start-question',
        style: { width: '100%' },
        disabled: noActive || (!hasCustom && local.topics.size === 0) ? true : undefined,
        onClick: () => {
          if (!local.activeDbId) return;
          if (hasCustom) {
            onCustomQuestion?.(local.customPrompt.trim());
          } else {
            const topics = [...local.topics];
            if (topics.length === 0) return;
            onStartQuestion?.(local.difficulty, topics);
          }
        },
      }, hasCustom ? '▶ 按自定义要求出题' : '▶ ' + ZH.practice.startQuestion),
    );
  }

  function buildQuestionBody() {
    if (!local.question) {
      return el('p', { class: 'question-empty' }, '点击「出题」生成题目。');
    }
    const children = [
      el('div', { class: 'question-meta' },
        el('span', { class: 'badge badge-difficulty' }, local.question.difficulty),
        ...(local.question.topics ?? []).map((t) => el('span', { class: 'badge' }, t)),
      ),
      el('div', { class: 'question-prompt', 'data-question-prompt': '' }, local.question.prompt),
    ];

    // Reference answer toggle — lives inside the question card now.
    children.push(
      el('div', { class: 'question-ref-section' },
        el('button', {
          type: 'button',
          class: 'btn question-ref-btn',
          'data-action': 'toggle-ref-sql',
          onClick: () => {
            local.refRevealed = !local.refRevealed;
            onToggleRefSql?.(local.refRevealed);
            refreshBodies();
          },
        }, local.refRevealed ? '隐藏参考答案' : '查看参考答案'),
        local.refRevealed && local.question.refSql
          ? el('pre', { class: 'question-ref-sql' },
              el('code', {}, ...renderSqlAsNodes(local.question.refSql)),
            )
          : null,
      ),
    );

    return el('div', {}, ...children);
  }

  function buildEditorBody() { return el('div', { 'data-editor-mount': '' }); }
  function buildResultBody() { return el('div', { 'data-result-mount': '' }); }
  function buildTutorBody()  { return el('div', { 'data-tutor-mount':  '' }); }

  function refreshBodies() {
    if (!panels.question) return;

    panels.question.setMeta(
      local.question
        ? `${local.question.difficulty} · ${(local.question.topics ?? []).join(', ')}`
        : '未出题',
    );
    swapBody(panels.question.bodyContainer, buildQuestionBody());

    panels.questionGen.setMeta(
      (local.activeDbName ? `${local.activeDbName} · ` : '')
      + `${local.difficulty} · ${local.topics.size} 知识点`,
    );
    swapBody(panels.questionGen.bodyContainer, buildQuestionGenBody());

    if (panels.editor.bodyContainer.children.length === 0) {
      swapBody(panels.editor.bodyContainer, buildEditorBody());
    }
    if (panels.result.bodyContainer.children.length === 0) {
      swapBody(panels.result.bodyContainer, buildResultBody());
    }
    if (panels.tutor.bodyContainer.children.length === 0) {
      swapBody(panels.tutor.bodyContainer, buildTutorBody());
    }
  }

  function swapBody(host, child) {
    clear(host);
    host.appendChild(child);
  }

  function buildAllPanels() {
    // Question panel — carries a "历史题目" button in its header.
    const historyQBtn = el('button', {
      type: 'button',
      class: 'pf-action pf-action-ref',
      'data-action': 'history-questions',
      title: '从历史题目中选择',
      onClick: () => showHistoryQuestionsModal(),
    }, '历史题目');

    panels.question = createPanel({
      title: '题目',
      headerExtra: [historyQBtn],
    });
    panels.questionGen = createPanel({
      title: '出题',
    });
    panels.editor = createPanel({
      title: '编辑器',
      // No vertical resize — the panel grows to fill its grid row.
      resize: 'none',
    });
    panels.result = createPanel({
      title: '结果',
      resize: 'none',
    });

    // Tutor panel — no longer carries the ref-answer button (moved to question card).
    panels.tutor = createPanel({
      title: '在线问答',
      resize: 'none',
    });
  }

  function applyLayout() {
    if (!practiceRoot) return;
    practiceRoot.style.setProperty('--col-side',     layout.side      + 'px');
    practiceRoot.style.setProperty('--col-tutor',    layout.tutor     + 'px');
    practiceRoot.style.setProperty('--row-question', layout.questionH + 'px');
    practiceRoot.style.setProperty('--row-editor',   layout.editorH   + 'px');
  }

  function persistLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function render() {
    clear(root);
    if (Object.keys(panels).length === 0) buildAllPanels();

    // Tag the qgen panel root so CSS can scope the "console" treatment
    // to it (accent border-left, mono meta, toolbar buttons in
    // pf-header-extra). Idempotent — safe to set on each render.
    panels.questionGen.root.setAttribute('data-panel-role', 'qgen');

    // Splitters — two vertical bars between the three columns, plus two
    // horizontal bars between sibling panels in the side and main columns.
    splitters.forEach((s) => s.dispose());
    splitters = [];
    const sideSplitter = createSplitter({
      orientation: 'vertical',
      onResize: (delta) => {
        layout.side = clamp(layout.side + delta, COL_MIN.side, COL_MAX.side);
        applyLayout();
      },
      onResizeEnd: persistLayout,
    });
    const tutorSplitter = createSplitter({
      orientation: 'vertical',
      onResize: (delta) => {
        // Right splitter shrinks tutor when dragged right (delta > 0).
        layout.tutor = clamp(layout.tutor - delta, COL_MIN.tutor, COL_MAX.tutor);
        applyLayout();
      },
      onResizeEnd: persistLayout,
    });
    const sideRowSplitter = createSplitter({
      orientation: 'horizontal',
      onResize: (delta) => {
        layout.questionH = clamp(layout.questionH + delta, ROW_MIN.questionH, ROW_MAX.questionH);
        applyLayout();
      },
      onResizeEnd: persistLayout,
    });
    const mainRowSplitter = createSplitter({
      orientation: 'horizontal',
      onResize: (delta) => {
        layout.editorH = clamp(layout.editorH + delta, ROW_MIN.editorH, ROW_MAX.editorH);
        applyLayout();
      },
      onResizeEnd: persistLayout,
    });
    splitters = [sideSplitter, tutorSplitter, sideRowSplitter, mainRowSplitter];

    practiceRoot = el('section', { class: 'practice-view' },
      el('div', { class: 'practice-side' },
        panels.question.root,
        sideRowSplitter.root,
        panels.questionGen.root,
      ),
      sideSplitter.root,
      el('div', { class: 'practice-main' },
        panels.editor.root,
        mainRowSplitter.root,
        panels.result.root,
      ),
      tutorSplitter.root,
      el('div', { class: 'practice-tutor' },
        panels.tutor.root,
      ),
    );
    root.appendChild(practiceRoot);

    applyLayout();
    refreshBodies();
  }

  /** Show a modal listing historical questions for the user to pick from. */
  function showHistoryQuestionsModal() {
    const questions = getHistoryQuestions?.() ?? [];
    if (questions.length === 0) {
      alert('暂无历史题目。请先出题并提交答案。');
      return;
    }

    // Build a simple modal overlay.
    const backdrop = el('div', {
      class: 'hq-modal-backdrop',
      onClick: (ev) => { if (ev.target === backdrop) backdrop.remove(); },
    });
    const card = el('div', { class: 'hq-modal-card' },
      el('header', { class: 'hq-modal-header' },
        el('h3', {}, '历史题目'),
        el('button', {
          type: 'button',
          class: 'btn btn-ghost',
          onClick: () => backdrop.remove(),
        }, '✕'),
      ),
      el('ul', { class: 'hq-modal-list' },
        ...questions.map((q) => {
          const status = q.status ?? 'pending';
          const statusLabel = status === 'correct'   ? '已答对'
                            : status === 'recovered' ? '已纠正'
                            : status === 'wrong'     ? '未解决'
                            : '未提交';
          return el('li', {
            class: 'hq-modal-item',
            'data-question-status': status,
            onClick: () => {
              backdrop.remove();
              onSelectHistoryQuestion?.(q);
            },
          },
            el('div', { class: 'hq-modal-item-meta' },
              el('span', { class: `hq-modal-status hq-modal-status-${status}` }, statusLabel),
              el('span', { class: 'badge badge-difficulty' }, q.questionDifficulty ?? q.difficulty ?? '?'),
              ...(q.questionTopics ?? q.topics ?? []).slice(0, 3).map((t) =>
                el('span', { class: 'badge' }, t),
              ),
              el('span', { class: 'meta' }, q.databaseName ?? ''),
              q.attemptsCount > 1
                ? el('span', { class: 'meta hq-modal-attempts' },
                    `· 提交 ${q.attemptsCount} 次`,
                  )
                : null,
            ),
            el('p', { class: 'hq-modal-item-prompt' },
              q.questionPrompt ?? q.prompt ?? '（题面缺失）',
            ),
          );
        }),
      ),
    );
    backdrop.appendChild(card);
    (dialogRoot ?? document.body).appendChild(backdrop);
  }

  return {
    mount(props = {}) {
      Object.assign(local, sanitiseProps(props));
      render();
    },
    update(props = {}) {
      Object.assign(local, sanitiseProps(props));
      refreshBodies();
    },
    /** Imperatively notify the practice view that the Tutor's
     *  refRevealed state changed (e.g. user clicked Hide inside the
     *  card). Keeps the header button label in sync. */
    setRefRevealed(v) {
      local.refRevealed = Boolean(v);
      refreshBodies();
    },
    unmount() {
      splitters.forEach((s) => s.dispose());
      splitters = [];
      for (const p of Object.values(panels)) p.dispose();
      panels = {};
      practiceRoot = null;
      clear(root);
      // Clean up any open history-questions modal.
      if (dialogRoot) {
        const backdrop = dialogRoot.querySelector('.hq-modal-backdrop');
        if (backdrop) backdrop.remove();
      }
    },
  };
}

function sanitiseProps(p) {
  const out = {};
  if (p.difficulty !== undefined)    out.difficulty = p.difficulty;
  if (p.topics !== undefined)        out.topics = p.topics instanceof Set ? p.topics : new Set(p.topics);
  if (p.activeDbId !== undefined)    out.activeDbId = p.activeDbId;
  if (p.activeDbName !== undefined)  out.activeDbName = p.activeDbName;
  if (p.question !== undefined)      out.question = p.question;
  if (p.refRevealed !== undefined)   out.refRevealed = Boolean(p.refRevealed);
  return out;
}

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...COL_DEFAULTS, ...ROW_DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      side:      Number.isFinite(parsed.side)      ? parsed.side      : COL_DEFAULTS.side,
      tutor:     Number.isFinite(parsed.tutor)     ? parsed.tutor     : COL_DEFAULTS.tutor,
      questionH: Number.isFinite(parsed.questionH) ? parsed.questionH : ROW_DEFAULTS.questionH,
      editorH:   Number.isFinite(parsed.editorH)   ? parsed.editorH   : ROW_DEFAULTS.editorH,
    };
  } catch {
    return { ...COL_DEFAULTS, ...ROW_DEFAULTS };
  }
}

export default createPracticeView;
