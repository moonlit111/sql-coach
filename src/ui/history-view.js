// History & wrong-answer review view.
//
// Validates: R15.4 (sort descending by submittedAt, wrong-only filter),
// R15.5 (clearing answers does NOT remove the settings key).
//
// Property 11 (tests/ui/history-view.property.test.js) drives the public
// helpers `sortDesc`, `filterWrong`, `renderHistory`, and `clearHistory`.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { PersistKey } from '../persist/schema.js';

/**
 * Strict-descending sort by `submittedAt`. Pure function: returns a new
 * array; the input is left untouched. Records with the same `submittedAt`
 * preserve their relative order (stable sort).
 *
 * @template {{ submittedAt: number }} R
 * @param {readonly R[]} records
 * @returns {R[]}
 */
export function sortDesc(records) {
  return [...records].sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
}

/**
 * Keep only the records whose verdict is wrong (`verdict.correct === false`).
 * Pure function. Property 11.2: `filterWrong(rs)` is a subset and the count
 * matches the number of wrong records.
 *
 * @template {{ verdict: { correct: boolean } }} R
 * @param {readonly R[]} records
 * @returns {R[]}
 */
export function filterWrong(records) {
  return records.filter((r) => r && r.verdict && r.verdict.correct === false);
}

/**
 * Clear answer history. Removes the ANSWERS key only; SETTINGS and other
 * slots are preserved (R15.5 / Property 11.4).
 *
 * @param {{ remove: (k: string) => void }} store
 */
export function clearHistory(store) {
  store.remove(PersistKey.ANSWERS);
}

/**
 * Render the history list into `root`. Each call clears the previous
 * children first so the function is idempotent.
 *
 * `props.records`           — the list to display (will be sorted internally)
 * `props.filterWrongOnly`   — when true, only records with verdict.correct === false
 * `props.onToggleFilter`    — callback when the user toggles "只看错题"
 * `props.onClear`           — callback when the user clicks "清空历史"
 *
 * @param {HTMLElement} root
 * @param {{
 *   records: ReadonlyArray<{ id: string, questionId: string, submittedAt: number,
 *                            userSql: string, verdict: { correct: boolean } }>,
 *   filterWrongOnly?: boolean,
 *   onToggleFilter?: (next: boolean) => void,
 *   onClear?: () => void,
 * }} props
 */
export function renderHistory(root, props) {
  clear(root);
  const filterWrongOnly = Boolean(props.filterWrongOnly);
  const all = props.records ?? [];
  const filtered = filterWrongOnly ? filterWrong(all) : all;
  const sorted = sortDesc(filtered);

  const header = el(
    'header',
    { class: 'history-header' },
    el('h2', {}, ZH.history.title),
    el(
      'label',
      { class: 'history-filter' },
      el('input', {
        type: 'checkbox',
        'data-history-filter-wrong': '',
        checked: filterWrongOnly ? true : undefined,
        onChange: (ev) => {
          props.onToggleFilter?.(ev.target.checked);
        },
      }),
      ' ',
      ZH.history.filterWrong,
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'btn',
        'data-history-clear': '',
        onClick: () => props.onClear?.(),
      },
      ZH.history.clear,
    ),
  );

  root.appendChild(header);

  if (sorted.length === 0) {
    // R15.4 — exact "没有符合条件的错题" empty state. Only relevant when
    // the wrong-only filter is on; if the user has the filter off and
    // history is empty, we still render this message because R15.4 says
    // "no records to show" should land in the same empty state.
    const empty = el(
      'div',
      { class: 'history-empty', 'data-history-empty': '' },
      ZH.history.empty,
    );
    root.appendChild(empty);
    return;
  }

  const list = el('ul', { class: 'history-list' });
  for (const r of sorted) {
    const verdictLabel = r.verdict?.correct ? ZH.judge.correct : ZH.judge.wrong;
    list.appendChild(
      el(
        'li',
        {
          class: 'history-item',
          'data-history-correct': r.verdict?.correct ? 'true' : 'false',
        },
        el('div', { class: 'history-meta' },
          el('time', {}, formatTimestamp(r.submittedAt)),
          ' · ',
          el('span', { class: 'history-verdict' }, verdictLabel),
        ),
        el('pre', { class: 'history-sql' }, r.userSql ?? ''),
      ),
    );
  }
  root.appendChild(list);
}

/**
 * Lightweight ISO-ish timestamp. Renders as `YYYY-MM-DD HH:mm:ss` in local
 * time. Falsy/invalid timestamps render as an empty string.
 *
 * @param {number | undefined} ts
 * @returns {string}
 */
function formatTimestamp(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * View factory matching the Architecture pattern from the task brief.
 *
 * @param {{ root: HTMLElement, store?: { remove: (k: string) => void } }} deps
 */
export function createHistoryView({ root, store }) {
  let current = { records: [], filterWrongOnly: false };

  function render() {
    renderHistory(root, {
      records: current.records,
      filterWrongOnly: current.filterWrongOnly,
      onToggleFilter: (next) => {
        current = { ...current, filterWrongOnly: next };
        render();
      },
      onClear: () => {
        if (store) clearHistory(store);
        current = { ...current, records: [] };
        render();
      },
    });
  }

  return {
    mount(props = {}) {
      current = {
        records: props.records ?? [],
        filterWrongOnly: Boolean(props.filterWrongOnly),
      };
      render();
    },
    update(props = {}) {
      if (props.records !== undefined) current.records = props.records;
      if (props.filterWrongOnly !== undefined) current.filterWrongOnly = Boolean(props.filterWrongOnly);
      render();
    },
    unmount() {
      clear(root);
    },
  };
}

export default createHistoryView;
