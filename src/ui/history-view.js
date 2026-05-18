// History & wrong-answer review view (May 2026 v3 — per-question rollup).
//
// Validates: R15.4 (sort descending by submittedAt, wrong-only filter),
// R15.5 (clearing answers does NOT remove the settings key).
//
// Behaviour change vs v2:
//   - Records are aggregated BY questionId so each question shows up
//     exactly once in the list, with a tri-state status:
//       • correct   — only ever submitted correctly         (绿)
//       • recovered — first wrong, eventually correct       (黄)
//       • wrong     — submitted wrong with no later correct (红)
//     This survives browser restarts and "generate new question"
//     because the verdict is computed from persisted submissions, not
//     from in-memory session state.
//   - The "只看错题" filter now means "only show 红 (wrong + uncured)"
//     rather than "every submission whose verdict was false".
//   - Each row exposes the per-attempt SQL inside <details>; the
//     attempt count is shown in the header so users see "试了 3 次".
//
// Pure helpers (`sortDesc` / `filterWrong` / `clearHistory`) keep their
// original shape so Property 11 still passes — `filterWrong` continues
// to operate on AnswerRecords and is used by other call sites.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { PersistKey } from '../persist/schema.js';
import { renderSqlAsNodes } from './sql-highlight.js';

/**
 * @template {{ submittedAt: number }} R
 * @param {readonly R[]} records
 * @returns {R[]}
 */
export function sortDesc(records) {
  return [...records].sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
}

/**
 * @template {{ verdict: { correct: boolean } }} R
 * @param {readonly R[]} records
 * @returns {R[]}
 */
export function filterWrong(records) {
  return records.filter((r) => r && r.verdict && r.verdict.correct === false);
}

/**
 * @param {{ remove: (k: string) => void }} store
 */
export function clearHistory(store) {
  store.remove(PersistKey.ANSWERS);
}

/**
 * Compute the tri-state status for a single question from the full set
 * of submissions against it. Sort by submittedAt to make "later correct"
 * unambiguous regardless of original record order.
 *
 * @param {Array<{ verdict?: { correct?: boolean }, submittedAt?: number }>} attempts
 * @returns {'correct' | 'recovered' | 'wrong' | 'pending'}
 */
export function questionStatus(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return 'pending';
  const ordered = [...attempts].sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
  const hasCorrect = ordered.some((a) => a?.verdict?.correct === true);
  const hasWrong   = ordered.some((a) => a?.verdict?.correct === false);
  if (hasCorrect && hasWrong)  return 'recovered';   // 黄: had errors, eventually solved
  if (hasCorrect)              return 'correct';     // 绿: clean run
  if (hasWrong)                return 'wrong';       // 红: never solved
  return 'pending';
}

/**
 * Group answer records by questionId. The returned aggregates carry
 * everything the UI needs to render one row per question:
 *   • attempts            — all submissions, in submission order
 *   • status              — tri-state from {@link questionStatus}
 *   • latestSubmittedAt   — for top-level sorting
 *   • lastAttempt         — most recent submission (drives the prompt /
 *                           topics / database snapshot when displayed)
 *   • correctCount / wrongCount
 *
 * Records without a questionId (legacy / corrupted) are bucketed under
 * a synthesized id so they still appear in the list rather than vanish.
 *
 * @param {Array<any>} records
 * @returns {Array<{
 *   questionId: string,
 *   status: 'correct' | 'recovered' | 'wrong' | 'pending',
 *   attempts: any[],
 *   correctCount: number,
 *   wrongCount: number,
 *   firstSubmittedAt: number,
 *   latestSubmittedAt: number,
 *   lastAttempt: any,
 * }>}
 */
export function aggregateByQuestion(records) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const r of records ?? []) {
    if (!r) continue;
    const qid = r.questionId ?? `__no_qid__${r.id ?? Math.random()}`;
    if (!groups.has(qid)) groups.set(qid, []);
    groups.get(qid).push(r);
  }
  /** @type {ReturnType<typeof aggregateByQuestion>} */
  const out = [];
  for (const [questionId, attempts] of groups) {
    const ordered = [...attempts].sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
    const status = questionStatus(ordered);
    let correctCount = 0, wrongCount = 0;
    for (const a of ordered) {
      if (a?.verdict?.correct === true)  correctCount += 1;
      if (a?.verdict?.correct === false) wrongCount   += 1;
    }
    out.push({
      questionId,
      status,
      attempts: ordered,
      correctCount,
      wrongCount,
      firstSubmittedAt:  ordered[0]?.submittedAt ?? 0,
      latestSubmittedAt: ordered[ordered.length - 1]?.submittedAt ?? 0,
      lastAttempt:       ordered[ordered.length - 1],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public render (kept for tests).
// ---------------------------------------------------------------------------

/**
 * Render the history list into `root`. Idempotent.
 *
 * @param {HTMLElement} root
 * @param {{
 *   records: ReadonlyArray<AnswerLike>,
 *   filterWrongOnly?: boolean,
 *   topicFilter?: string,
 *   difficultyFilter?: string,
 *   databaseFilter?: string,
 *   searchQuery?: string,
 *   onToggleFilter?: (next: boolean) => void,
 *   onTopicFilterChange?: (v: string) => void,
 *   onDifficultyFilterChange?: (v: string) => void,
 *   onDatabaseFilterChange?: (v: string) => void,
 *   onSearchChange?: (v: string) => void,
 *   onClear?: () => void,
 *   onRedo?: (record: AnswerLike) => void,
 * }} props
 *
 * @typedef {{
 *   id: string,
 *   questionId: string,
 *   submittedAt: number,
 *   userSql: string,
 *   userSqlAlt?: string | null,
 *   verdict: { correct: boolean, diffSummary?: any, sandboxError?: any },
 *   questionPrompt?: string,
 *   questionDifficulty?: string,
 *   questionTopics?: string[],
 *   questionRefSql?: string,
 *   questionRefSqlAlt?: string | null,
 *   questionIsOrdered?: boolean,
 *   databaseId?: string | null,
 *   databaseName?: string,
 * }} AnswerLike
 */
export function renderHistory(root, props) {
  clear(root);

  const filterWrongOnly  = Boolean(props.filterWrongOnly);
  const topicFilter      = props.topicFilter ?? '';
  const difficultyFilter = props.difficultyFilter ?? '';
  const databaseFilter   = props.databaseFilter ?? '';
  const searchQuery      = (props.searchQuery ?? '').trim().toLowerCase();

  const all = props.records ?? [];

  // Build filter option lists from the data so the dropdowns reflect what
  // the user has actually answered.
  const topicSet = new Set();
  const diffSet  = new Set();
  const dbMap    = new Map();
  for (const r of all) {
    for (const t of r.questionTopics ?? []) topicSet.add(t);
    if (r.questionDifficulty) diffSet.add(r.questionDifficulty);
    if (r.databaseId) dbMap.set(r.databaseId, r.databaseName || r.databaseId);
  }

  // Aggregate per-question first — every downstream filter operates on
  // questions, not raw submissions. The "只看错题" filter shows any
  // question that has at least one wrong attempt (i.e. status `wrong` or
  // `recovered`) so the user can review everywhere they struggled, not
  // just the still-unsolved ones.
  const questions = aggregateByQuestion(all);

  const filtered = questions.filter((q) => {
    if (filterWrongOnly && q.status === 'correct') return false;
    if (filterWrongOnly && q.status === 'pending') return false;
    const ref = q.lastAttempt ?? {};
    if (topicFilter && !(ref.questionTopics ?? []).includes(topicFilter)) return false;
    if (difficultyFilter && ref.questionDifficulty !== difficultyFilter) return false;
    if (databaseFilter && ref.databaseId !== databaseFilter) return false;
    if (searchQuery) {
      const haystack = (ref.questionPrompt ?? '') + '\n'
        + q.attempts.map((a) => a.userSql ?? '').join('\n');
      if (!haystack.toLowerCase().includes(searchQuery)) return false;
    }
    return true;
  });
  // Sort by latestSubmittedAt so most recently touched questions float
  // to the top (matches the per-submission v2 behaviour).
  const sorted = [...filtered].sort((a, b) => (b.latestSubmittedAt ?? 0) - (a.latestSubmittedAt ?? 0));

  // ── Header: title + filters ────────────────────────────────────────
  const header = el('header', { class: 'history-header' },
    el('h2', {}, ZH.history.title),
    el('div', { class: 'history-stats' },
      el('span', { class: 'meta' },
        `${questions.length} 道题 · ${all.length} 次提交 · 当前 ${sorted.length} 道匹配`,
      ),
    ),
    el('button', {
      type: 'button',
      class: 'btn',
      'data-history-clear': '',
      onClick: () => props.onClear?.(),
    }, ZH.history.clear),
  );

  const filterBar = el('div', { class: 'history-filters' },
    el('label', { class: 'history-filter' },
      el('input', {
        type: 'checkbox',
        'data-history-filter-wrong': '',
        checked: filterWrongOnly ? true : undefined,
        onChange: (ev) => props.onToggleFilter?.(ev.target.checked),
      }),
      ' ', ZH.history.filterWrong,
    ),
    diffSet.size > 0
      ? el('select', {
          class: 'history-select',
          'data-history-difficulty': '',
          value: difficultyFilter,
          onChange: (ev) => props.onDifficultyFilterChange?.(ev.target.value),
        },
          el('option', { value: '' }, '全部难度'),
          ...[...diffSet].sort().map((d) => el('option', { value: d, selected: d === difficultyFilter ? true : undefined }, d)),
        )
      : null,
    topicSet.size > 0
      ? el('select', {
          class: 'history-select',
          'data-history-topic': '',
          value: topicFilter,
          onChange: (ev) => props.onTopicFilterChange?.(ev.target.value),
        },
          el('option', { value: '' }, '全部知识点'),
          ...[...topicSet].sort().map((t) => el('option', { value: t, selected: t === topicFilter ? true : undefined }, t)),
        )
      : null,
    dbMap.size > 0
      ? el('select', {
          class: 'history-select',
          'data-history-database': '',
          value: databaseFilter,
          onChange: (ev) => props.onDatabaseFilterChange?.(ev.target.value),
        },
          el('option', { value: '' }, '全部数据库'),
          ...[...dbMap.entries()].map(([id, name]) =>
            el('option', { value: id, selected: id === databaseFilter ? true : undefined }, name),
          ),
        )
      : null,
    el('input', {
      type: 'search',
      class: 'history-search',
      'data-history-search': '',
      placeholder: '搜索题面或 SQL……',
      value: props.searchQuery ?? '',
      onInput: (ev) => props.onSearchChange?.(ev.target.value),
    }),
  );

  root.appendChild(header);
  root.appendChild(filterBar);

  if (sorted.length === 0) {
    root.appendChild(
      el('div', { class: 'history-empty', 'data-history-empty': '' }, ZH.history.empty),
    );
    return;
  }

  // ── List ───────────────────────────────────────────────────────────
  const list = el('ul', { class: 'history-list' });
  for (const q of sorted) {
    list.appendChild(renderItem(q, props.onRedo));
  }
  root.appendChild(list);
}

const STATUS_LABEL = {
  correct:   '已答对',
  recovered: '已纠正',
  wrong:     '未解决',
  pending:   '未提交',
};

/**
 * Render a single question aggregate. The header shows tri-state
 * status, attempt counts, topics, source database; the <details>
 * pane unfolds the per-attempt SQL history (latest at the top).
 *
 * @param {ReturnType<typeof aggregateByQuestion>[number]} q
 * @param {((record:any) => void)=} onRedo
 */
function renderItem(q, onRedo) {
  const ref       = q.lastAttempt ?? {};
  const promptText = ref.questionPrompt ?? '（题目数据缺失）';
  const topics    = ref.questionTopics  ?? [];
  const diff      = ref.questionDifficulty ?? '?';
  const dbName    = ref.databaseName ?? (ref.databaseId ?? '未知数据库');
  const statusLabel = STATUS_LABEL[q.status] ?? q.status;
  const attemptsLabel = `共 ${q.attempts.length} 次提交` +
    (q.wrongCount > 0 ? `，错 ${q.wrongCount} 次` : '') +
    (q.correctCount > 0 ? `，对 ${q.correctCount} 次` : '');

  return el('li',
    {
      class: 'history-item',
      // Keep legacy data-history-correct for any CSS still referencing it,
      // but the new tri-state lives on data-question-status.
      'data-history-correct': q.status === 'correct' ? 'true'
        : (q.status === 'wrong' ? 'false' : 'mixed'),
      'data-question-status': q.status,
    },
    el('div', { class: 'history-item-header' },
      el('div', { class: 'history-item-meta' },
        el('span', { class: 'badge badge-difficulty' }, diff),
        ...topics.slice(0, 4).map((t) => el('span', { class: 'badge' }, t)),
        topics.length > 4 ? el('span', { class: 'badge' }, `+${topics.length - 4}`) : null,
        el('span', { class: 'meta history-item-db' }, '· ' + dbName),
      ),
      el('div', { class: 'history-item-right' },
        el('time', { class: 'meta' }, formatTimestamp(q.latestSubmittedAt)),
        el('span', { class: `history-verdict history-verdict-${q.status}` },
          statusLabel,
        ),
      ),
    ),
    el('p', { class: 'history-item-prompt' }, promptText),
    el('p', { class: 'meta history-item-attempts' }, attemptsLabel),
    el('details', { class: 'history-item-details' },
      el('summary', {}, `查看每次提交（${q.attempts.length}）`),
      // Latest attempt first inside the details pane — matches the rest
      // of the view's "newest on top" convention.
      ...[...q.attempts].reverse().map((a, i) => {
        const aCorrect = a?.verdict?.correct === true;
        const idx = q.attempts.length - i;
        return el('section', {
          class: 'history-attempt history-attempt-' + (aCorrect ? 'ok' : 'fail'),
          'data-attempt-correct': aCorrect ? 'true' : 'false',
        },
          el('header', { class: 'history-attempt-head' },
            el('span', { class: 'history-attempt-idx' }, `#${idx}`),
            el('time', { class: 'meta' }, formatTimestamp(a.submittedAt)),
            el('span', { class: 'history-attempt-verdict' },
              aCorrect ? ZH.judge.correct : ZH.judge.wrong,
            ),
          ),
          el('div', { class: 'history-sql-block' },
            el('h5', {}, '你的 SQL'),
            el('pre', { class: 'history-sql' },
              el('code', {}, ...renderSqlAsNodes(a.userSql ?? '')),
            ),
            a.userSqlAlt
              ? el('div', {},
                  el('h5', {}, '你的备选 SQL'),
                  el('pre', { class: 'history-sql' },
                    el('code', {}, ...renderSqlAsNodes(a.userSqlAlt)),
                  ),
                )
              : null,
          ),
          a.verdict?.diffSummary
            ? el('p', { class: 'meta history-diff' },
                `差异：缺少 ${a.verdict.diffSummary.missingRows ?? 0} 行 · ` +
                `多出 ${a.verdict.diffSummary.extraRows ?? 0} 行`,
              )
            : null,
          a.verdict?.sandboxError
            ? el('p', { class: 'meta history-sandbox-error' },
                '执行错误：' + (a.verdict.sandboxError.message ?? a.verdict.sandboxError.kind ?? '未知'),
              )
            : null,
        );
      }),
      ref.questionRefSql
        ? el('section', { class: 'history-attempt history-attempt-ref' },
            el('header', { class: 'history-attempt-head' },
              el('span', { class: 'history-attempt-idx' }, '参考'),
            ),
            el('div', { class: 'history-sql-block' },
              el('h5', {}, '参考 SQL'),
              el('pre', { class: 'history-sql' },
                el('code', {}, ...renderSqlAsNodes(ref.questionRefSql)),
              ),
            ),
          )
        : null,
    ),
    onRedo
      ? el('div', { class: 'history-item-actions' },
          el('button', {
            type: 'button',
            class: 'btn btn-primary',
            'data-action': 'redo-question',
            disabled: !ref.questionPrompt ? true : undefined,
            title: ref.questionPrompt ? '在练习页重做这道题' : '题目数据缺失，无法重做',
            onClick: () => onRedo(ref),
          }, '🗘 重做这道题'),
        )
      : null,
  );
}

function formatTimestamp(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// View factory.
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   root: HTMLElement,
 *   store?: { remove: (k: string) => void },
 *   onRedo?: (record: any) => void,
 *   onClear?: () => void,
 * }} deps
 */
export function createHistoryView({ root, store, onRedo, onClear }) {
  let current = {
    records: [],
    filterWrongOnly: false,
    topicFilter: '',
    difficultyFilter: '',
    databaseFilter: '',
    searchQuery: '',
  };

  /** @type {HTMLElement | null} */ let statsEl = null;
  /** @type {HTMLElement | null} */ let listContainer = null;

  /** Compute the filtered + sorted question aggregates from current state. */
  function computeFiltered() {
    const all = current.records ?? [];
    const filterWrongOnly  = current.filterWrongOnly;
    const topicFilter      = current.topicFilter;
    const difficultyFilter = current.difficultyFilter;
    const databaseFilter   = current.databaseFilter;
    const searchQuery      = (current.searchQuery ?? '').trim().toLowerCase();

    const questions = aggregateByQuestion(all);
    const filtered = questions.filter((q) => {
      // 只看错题 = show 红 (wrong) and 黄 (recovered): everywhere the
      // user has stumbled. Hides 绿 / 待提交.
      if (filterWrongOnly && (q.status === 'correct' || q.status === 'pending')) return false;
      const ref = q.lastAttempt ?? {};
      if (topicFilter && !(ref.questionTopics ?? []).includes(topicFilter)) return false;
      if (difficultyFilter && ref.questionDifficulty !== difficultyFilter) return false;
      if (databaseFilter && ref.databaseId !== databaseFilter) return false;
      if (searchQuery) {
        const haystack = (ref.questionPrompt ?? '') + '\n'
          + q.attempts.map((a) => a.userSql ?? '').join('\n');
        if (!haystack.toLowerCase().includes(searchQuery)) return false;
      }
      return true;
    });
    return [...filtered].sort(
      (a, b) => (b.latestSubmittedAt ?? 0) - (a.latestSubmittedAt ?? 0),
    );
  }

  /** Rebuild only the list area + stats counter without touching the filter bar. */
  function refreshList() {
    if (!listContainer) return;
    const all = current.records ?? [];
    const sorted = computeFiltered();
    const totalQuestions = aggregateByQuestion(all).length;

    // Update stats text — distinguishes question count from submission
    // count so users see "5 道题, 12 次提交" rather than just "12 条".
    if (statsEl) {
      statsEl.textContent = `${totalQuestions} 道题 · ${all.length} 次提交 · 当前 ${sorted.length} 道匹配`;
    }

    clear(listContainer);
    if (sorted.length === 0) {
      listContainer.appendChild(
        el('div', { class: 'history-empty', 'data-history-empty': '' }, ZH.history.empty),
      );
      return;
    }
    const list = el('ul', { class: 'history-list' });
    for (const q of sorted) {
      list.appendChild(renderItem(q, onRedo));
    }
    listContainer.appendChild(list);
  }

  /** Full render — builds header, filter bar, and list container. */
  function render() {
    clear(root);

    statsEl = el('span', { class: 'meta' });

    const header = el('header', { class: 'history-header' },
      el('h2', {}, ZH.history.title),
      el('div', { class: 'history-stats' }, statsEl),
      el('button', {
        type: 'button',
        class: 'btn',
        'data-history-clear': '',
        onClick: () => {
          if (store) clearHistory(store);
          current.records = [];
          onClear?.();
          render();
        },
      }, ZH.history.clear),
    );

    // Build filter option lists from the data.
    const all = current.records ?? [];
    const topicSet = new Set();
    const diffSet  = new Set();
    const dbMap    = new Map();
    for (const r of all) {
      for (const t of r.questionTopics ?? []) topicSet.add(t);
      if (r.questionDifficulty) diffSet.add(r.questionDifficulty);
      if (r.databaseId) dbMap.set(r.databaseId, r.databaseName || r.databaseId);
    }

    const filterBar = el('div', { class: 'history-filters' },
      el('label', { class: 'history-filter' },
        el('input', {
          type: 'checkbox',
          'data-history-filter-wrong': '',
          checked: current.filterWrongOnly ? true : undefined,
          onChange: (ev) => { current.filterWrongOnly = ev.target.checked; refreshList(); },
        }),
        ' ', ZH.history.filterWrong,
      ),
      diffSet.size > 0
        ? el('select', {
            class: 'history-select',
            'data-history-difficulty': '',
            value: current.difficultyFilter,
            onChange: (ev) => { current.difficultyFilter = ev.target.value; refreshList(); },
          },
            el('option', { value: '' }, '全部难度'),
            ...[...diffSet].sort().map((d) => el('option', { value: d, selected: d === current.difficultyFilter ? true : undefined }, d)),
          )
        : null,
      topicSet.size > 0
        ? el('select', {
            class: 'history-select',
            'data-history-topic': '',
            value: current.topicFilter,
            onChange: (ev) => { current.topicFilter = ev.target.value; refreshList(); },
          },
            el('option', { value: '' }, '全部知识点'),
            ...[...topicSet].sort().map((t) => el('option', { value: t, selected: t === current.topicFilter ? true : undefined }, t)),
          )
        : null,
      dbMap.size > 0
        ? el('select', {
            class: 'history-select',
            'data-history-database': '',
            value: current.databaseFilter,
            onChange: (ev) => { current.databaseFilter = ev.target.value; refreshList(); },
          },
            el('option', { value: '' }, '全部数据库'),
            ...[...dbMap.entries()].map(([id, name]) =>
              el('option', { value: id, selected: id === current.databaseFilter ? true : undefined }, name),
            ),
          )
        : null,
      el('input', {
        type: 'search',
        class: 'history-search',
        'data-history-search': '',
        placeholder: '搜索题面或 SQL……',
        value: current.searchQuery ?? '',
        onInput: (ev) => { current.searchQuery = ev.target.value; refreshList(); },
      }),
    );

    listContainer = el('div', { class: 'history-list-container' });

    root.appendChild(header);
    root.appendChild(filterBar);
    root.appendChild(listContainer);

    refreshList();
  }

  return {
    mount(props = {}) {
      current.records = props.records ?? [];
      if (props.filterWrongOnly !== undefined) current.filterWrongOnly = Boolean(props.filterWrongOnly);
      render();
    },
    update(props = {}) {
      let needFullRender = false;
      if (props.records !== undefined) current.records = props.records;
      if (props.filterWrongOnly !== undefined) {
        const next = Boolean(props.filterWrongOnly);
        if (next !== current.filterWrongOnly) {
          current.filterWrongOnly = next;
          needFullRender = true; // checkbox state changed externally
        }
      }
      // If the list container exists we can do a targeted refresh;
      // otherwise fall back to full render (first mount or after unmount).
      if (!needFullRender && listContainer) {
        refreshList();
      } else {
        render();
      }
    },
    unmount() { clear(root); statsEl = null; listContainer = null; },
  };
}

export default createHistoryView;
