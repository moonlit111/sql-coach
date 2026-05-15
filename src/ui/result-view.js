// Result view — compact verdict bar + comparison modal.
//
// Shows a verdict indicator (correct/wrong) with a button to view the
// full result comparison. The modal shows user result vs expected result
// side by side. Auto-opens on new submission results.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   dialogRoot?: HTMLElement,
 *   onAskAi?: () => void,
 * }} deps
 */
export function createResultView({ root, dialogRoot, onAskAi }) {
  let local = {
    /** @type {{ columns: string[], rows: any[][], truncated?: boolean } | null} */ result: null,
    /** @type {{ columns: string[], rows: any[][] } | null} */ expectedResult: null,
    /** @type {{ kind: string, message: string } | null} */ sandboxError: null,
    /** @type {{ correct: boolean, diffSummary?: any, sandboxError?: any } | null} */ verdict: null,
  };

  function render() {
    clear(root);

    if (!local.verdict && !local.sandboxError && !local.result) {
      root.appendChild(
        el('div', { class: 'result-empty' }, '提交答案后在此显示结果。'),
      );
      return;
    }

    if (local.verdict) {
      const v = local.verdict;
      const correct = v.correct;
      root.appendChild(
        el('div', {
          class: 'result-verdict ' + (correct ? 'result-verdict-ok' : 'result-verdict-fail'),
          'data-verdict': correct ? 'correct' : 'wrong',
        },
          el('span', { class: 'result-verdict-icon' }, correct ? '✓' : '✗'),
          el('span', { class: 'result-verdict-label' }, correct ? ZH.judge.correct : ZH.judge.wrong),
          v.diffSummary && !correct
            ? el('span', { class: 'result-verdict-detail' },
                `缺少 ${v.diffSummary.missingRows ?? 0} 行 · 多出 ${v.diffSummary.extraRows ?? 0} 行`,
              )
            : null,
          v.sandboxError
            ? el('span', { class: 'result-verdict-detail' },
                `${v.sandboxError.message ?? v.sandboxError.kind}`,
              )
            : null,
        ),
      );
    }

    if (local.sandboxError && !local.verdict) {
      root.appendChild(
        el('div', { class: 'result-verdict result-verdict-fail' },
          el('span', { class: 'result-verdict-icon' }, '✗'),
          el('span', { class: 'result-verdict-label' }, ZH.judge.executeError),
          el('span', { class: 'result-verdict-detail' },
            local.sandboxError.message ?? local.sandboxError.kind,
          ),
        ),
      );
    }

    // Button to show comparison modal
    if (local.result || local.expectedResult) {
      root.appendChild(
        el('button', {
          type: 'button',
          class: 'btn result-show-btn',
          onClick: () => showResultModal(),
        }, '查看运行结果'),
      );
    }
  }

  function showResultModal() {
    const target = dialogRoot ?? document.body;

    // Remove any existing modal first
    const existing = target.querySelector('.result-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = el('div', {
      class: 'result-modal-backdrop',
      onClick: (ev) => { if (ev.target === backdrop) backdrop.remove(); },
    });

    const content = el('div', { class: 'result-modal-content' });

    // Verdict banner at top of modal
    if (local.verdict) {
      const correct = local.verdict.correct;
      content.appendChild(
        el('div', {
          class: 'result-modal-verdict ' + (correct ? 'result-verdict-ok' : 'result-verdict-fail'),
        },
          el('span', { class: 'result-verdict-icon' }, correct ? '✓' : '✗'),
          el('span', {}, correct ? '通过' : '未通过'),
          local.verdict.diffSummary && !correct
            ? el('span', { class: 'result-verdict-detail' },
                `缺少 ${local.verdict.diffSummary.missingRows ?? 0} 行 · 多出 ${local.verdict.diffSummary.extraRows ?? 0} 行`,
              )
            : null,
        ),
      );
    }

    // Side-by-side comparison
    const hasUser = local.result && local.result.rows?.length > 0;
    const hasExpected = local.expectedResult && local.expectedResult.rows?.length > 0;

    if (hasUser || hasExpected) {
      const comparison = el('div', { class: 'result-comparison' });

      // User result
      const userSection = el('div', { class: 'result-compare-section' },
        el('h4', { class: 'result-compare-title result-compare-user' }, `你的结果（${hasUser ? local.result.rows.length : 0} 行）`),
      );
      if (hasUser) {
        if (local.result.truncated) {
          userSection.appendChild(
            el('div', { class: 'result-modal-truncation' }, ZH.errors.sandboxRowLimit),
          );
        }
        userSection.appendChild(renderTable(local.result));
      } else {
        userSection.appendChild(el('p', { class: 'result-compare-empty' }, '无结果'));
      }
      comparison.appendChild(userSection);

      // Expected result
      const expectedSection = el('div', { class: 'result-compare-section' },
        el('h4', { class: 'result-compare-title result-compare-expected' }, `预期结果（${hasExpected ? local.expectedResult.rows.length : 0} 行）`),
      );
      if (hasExpected) {
        expectedSection.appendChild(renderTable(local.expectedResult));
      } else {
        expectedSection.appendChild(el('p', { class: 'result-compare-empty' }, '无预期结果'));
      }
      comparison.appendChild(expectedSection);

      content.appendChild(comparison);
    } else if (local.sandboxError || local.verdict?.sandboxError) {
      const err = local.sandboxError ?? local.verdict?.sandboxError;
      content.appendChild(
        el('div', { class: 'result-modal-error' },
          `执行错误：${err?.message ?? err?.kind ?? '未知'}`,
        ),
      );
    }

    const card = el('div', { class: 'result-modal-card' },
      el('header', { class: 'result-modal-header' },
        el('h3', {}, '运行结果对照'),
      ),
      content,
      el('footer', { class: 'result-modal-footer' },
        el('button', {
          type: 'button',
          class: 'btn',
          'data-action': 'result-ask-ai',
          onClick: () => {
            backdrop.remove();
            onAskAi?.();
          },
        }, '询问 AI'),
        el('button', {
          type: 'button',
          class: 'btn btn-primary',
          'data-action': 'result-done',
          onClick: () => backdrop.remove(),
        }, '完成'),
      ),
    );

    backdrop.appendChild(card);
    target.appendChild(backdrop);
  }

  return {
    mount(props = {}) {
      local = {
        result: props.result ?? null,
        expectedResult: props.expectedResult ?? null,
        sandboxError: props.sandboxError ?? null,
        verdict: props.verdict ?? null,
      };
      render();
    },
    update(props = {}) {
      const prevVerdict = local.verdict;
      if ('result' in props) local.result = props.result;
      if ('expectedResult' in props) local.expectedResult = props.expectedResult;
      if ('sandboxError' in props) local.sandboxError = props.sandboxError;
      if ('verdict' in props) local.verdict = props.verdict;
      render();

      // Auto-open the comparison modal whenever a NEW verdict identity
      // arrives with a result attached. Identity check (rather than the
      // previous "null → non-null only" guard) means the modal also pops
      // up on the second/third/Nth submission for the same question —
      // otherwise the user fixes a wrong answer, resubmits, and gets no
      // confirmation that it landed.
      if (local.verdict && local.verdict !== prevVerdict && local.result) {
        showResultModal();
      }
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
