// Result view — HTML table for ResultSet + truncation banner +
// verdict bar (绿色 correct / 红色 wrong + diff summary).
//
// Validates: R10.5 (truncation banner), R12.6 (verdict + diff summary).

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';

/**
 * @param {{ root: HTMLElement }} deps
 */
export function createResultView({ root }) {
  let local = {
    /** @type {{ columns: string[], rows: any[][], truncated?: boolean } | null} */ result: null,
    /** @type {{ kind: string, message: string } | null} */ sandboxError: null,
    /** @type {{ correct: boolean, diffSummary?: any, sandboxError?: any } | null} */ verdict: null,
  };

  function render() {
    clear(root);

    if (local.verdict) {
      const v = local.verdict;
      const cls = v.correct ? 'verdict verdict-correct' : 'verdict verdict-wrong';
      const label = v.correct ? ZH.judge.correct : ZH.judge.wrong;
      root.appendChild(
        el(
          'div',
          {
            class: cls,
            'data-verdict': v.correct ? 'correct' : 'wrong',
            style: {
              backgroundColor: v.correct ? '#d4edda' : '#f8d7da',
              color: v.correct ? '#155724' : '#721c24',
              padding: '8px 12px',
              borderRadius: '4px',
              marginBottom: '8px',
            },
          },
          label,
          v.diffSummary
            ? el('span', { class: 'verdict-diff' },
                ` · ${ZH.judge.diffMissingRows}: ${v.diffSummary.missingRows ?? 0}` +
                ` · ${ZH.judge.diffExtraRows}: ${v.diffSummary.extraRows ?? 0}`,
              )
            : null,
          v.sandboxError
            ? el('span', { class: 'verdict-sandbox-error' },
                ` · ${ZH.judge.executeError}：${v.sandboxError.message ?? v.sandboxError.kind}`,
              )
            : null,
        ),
      );
    }

    if (local.sandboxError && !local.verdict) {
      root.appendChild(
        el(
          'div',
          {
            class: 'sandbox-error',
            'data-sandbox-error': '',
            style: { color: '#721c24', padding: '8px 12px' },
          },
          `${ZH.judge.executeError}：${local.sandboxError.message ?? local.sandboxError.kind}`,
        ),
      );
    }

    if (local.result) {
      // R10.5 truncation banner.
      if (local.result.truncated) {
        root.appendChild(
          el(
            'div',
            {
              class: 'truncation-banner',
              'data-truncation-banner': '',
              style: {
                backgroundColor: '#fff3cd',
                color: '#856404',
                padding: '6px 12px',
                marginBottom: '6px',
              },
            },
            ZH.errors.sandboxRowLimit,
          ),
        );
      }
      root.appendChild(renderTable(local.result));
    }
  }

  return {
    mount(props = {}) {
      local = {
        result: props.result ?? null,
        sandboxError: props.sandboxError ?? null,
        verdict: props.verdict ?? null,
      };
      render();
    },
    update(props = {}) {
      if ('result' in props) local.result = props.result;
      if ('sandboxError' in props) local.sandboxError = props.sandboxError;
      if ('verdict' in props) local.verdict = props.verdict;
      render();
    },
    unmount() { clear(root); },
  };
}

function renderTable(rs) {
  const cols = rs.columns ?? [];
  const rows = rs.rows ?? [];
  return el('table', { class: 'result-table', 'data-result-table': '' },
    el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', {}, c)))),
    el('tbody', {},
      ...rows.map((row) =>
        el('tr', {}, ...row.map((cell) => el('td', {}, cell == null ? 'NULL' : String(cell)))),
      ),
    ),
  );
}

export default createResultView;
