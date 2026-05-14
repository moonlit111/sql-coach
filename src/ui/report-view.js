// [OPT] Report view (R16.1, R16.2, R16.3, R16.4).
//
// Renders the Reporter agent's Markdown output and exposes a "导出 Markdown"
// button that creates a Blob and triggers a download. Gated on
// `history.length >= 5` (R16.1).

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';

/**
 * @param {{ root: HTMLElement, onGenerate?: () => void }} deps
 */
export function createReportView({ root, onGenerate } = {}) {
  let local = {
    /** @type {string} */ markdown: '',
    /** @type {number} */ historyLength: 0,
  };

  function render() {
    clear(root);

    const gated = local.historyLength < 5;

    const header = el('h2', {}, ZH.report.title);
    const generateBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        'data-action': 'generate-report',
        disabled: gated ? true : undefined,
        onClick: () => onGenerate?.(),
      },
      gated ? `至少完成 5 题（当前 ${local.historyLength}）` : '生成报告',
    );

    const exportBtn = local.markdown
      ? el(
          'button',
          {
            type: 'button',
            class: 'btn',
            'data-action': 'export-markdown',
            onClick: () => downloadMarkdown(local.markdown),
          },
          ZH.report.exportMarkdown,
        )
      : null;

    const body = local.markdown
      ? el('pre', { class: 'report-body', 'data-report-body': '' }, local.markdown)
      : el('p', { class: 'report-empty' }, '尚未生成报告。');

    root.appendChild(
      el('section', { class: 'report-view' }, header, generateBtn, exportBtn, body),
    );
  }

  return {
    mount(props = {}) {
      local.markdown = props.markdown ?? '';
      local.historyLength = props.historyLength ?? 0;
      render();
    },
    update(props = {}) {
      if (props.markdown !== undefined) local.markdown = props.markdown;
      if (props.historyLength !== undefined) local.historyLength = props.historyLength;
      render();
    },
    unmount() { clear(root); },
  };
}

function downloadMarkdown(text) {
  try {
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sql-coach-report.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch {
    /* no-op in environments without Blob/URL */
  }
}

export default createReportView;
