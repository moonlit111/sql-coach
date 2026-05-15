// [OPT] Report view (R16.1, R16.2, R16.3, R16.4).
//
// Renders a multi-section ability report assembled from two sources:
//   • Deterministic statistics derived directly from the answer history
//     (per-topic correctness rates, per-difficulty distribution).
//   • The Reporter agent's structured JSON output (summary, multi-
//     dimensional scores, weak-topic advice, next-step recommendation).
//
// All visualisation is plain SVG — no charting library — to keep the
// build dependency-free and the print/PDF output crisp.
//
// Export options:
//   • Markdown — synthesised from the report object on demand (R16.4).
//   • PDF      — html2canvas snapshot of the report DOM, paginated into
//                A4 by jsPDF. Both libs are loaded via CDN in index.html;
//                we degrade gracefully if either is missing.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { TOPICS } from '../data/topics.js';
import { DIFFICULTY_LEVELS } from '../types.js';
import { summariseHistory } from '../orchestrator/prompts/reporter.js';
import { store } from '../persist/store.js';
import { PersistKey } from '../persist/schema.js';

const TOPIC_ZH = Object.fromEntries(TOPICS.map((t) => [t.id, t.zh]));

/**
 * @param {{ root: HTMLElement, onGenerate?: () => void }} deps
 */
export function createReportView({ root, onGenerate } = {}) {
  let local = {
    /** @type {null | object} */ report: null,
    /** @type {Array<any>} */     history: [],
    /** Tracks an in-flight PDF export so the button shows a spinner. */
    exporting: false,
  };

  /** Track the report-body DOM root so the PDF exporter can snapshot it
   *  (we exclude the toolbar from the snapshot). */
  /** @type {HTMLElement | null} */ let reportBodyEl = null;

  /** Resolve the history records to render against. Prefers what main.js
   *  passed in (reactive), but falls back to a direct localStorage read
   *  when the prop is empty — guards against in-memory state races and
   *  surfaces persisted data after a browser restart. */
  function resolveHistory() {
    if (Array.isArray(local.history) && local.history.length > 0) return local.history;
    try {
      const persisted = store.get(PersistKey.ANSWERS);
      if (Array.isArray(persisted) && persisted.length > 0) return persisted;
    } catch { /* swallow — fallback to whatever local.history is */ }
    return Array.isArray(local.history) ? local.history : [];
  }

  function render() {
    clear(root);

    const history = resolveHistory();
    const gated = history.length < 5 && !local.report;
    const generateBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        'data-action': 'generate-report',
        disabled: gated || local.exporting ? true : undefined,
        onClick: () => onGenerate?.(),
      },
      gated
        ? `至少完成 5 题（已答 ${history.length} 题）`
        : (local.report ? ZH.report.regenerate : '生成报告'),
    );

    const exportMdBtn = local.report
      ? el(
          'button',
          {
            type: 'button',
            class: 'btn',
            'data-action': 'export-markdown',
            onClick: () => downloadMarkdown(reportToMarkdown(local.report)),
          },
          ZH.report.exportMarkdown,
        )
      : null;

    const exportPdfBtn = local.report
      ? el(
          'button',
          {
            type: 'button',
            class: 'btn',
            'data-action': 'export-pdf',
            disabled: local.exporting ? true : undefined,
            onClick: () => exportPdf(),
          },
          local.exporting ? '导出中…' : ZH.report.exportPdf,
        )
      : null;

    const toolbar = el(
      'div',
      { class: 'report-toolbar', 'data-report-toolbar': '' },
      el('h2', { class: 'report-title' }, ZH.report.title),
      el('div', { class: 'report-actions' }, generateBtn, exportMdBtn, exportPdfBtn),
    );

    const body = local.report
      ? buildReportBody(local.report, history)
      : el('p', { class: 'report-empty' },
          history.length >= 5
            ? '点「生成报告」让 AI 综合你已经答过的 ' + history.length + ' 题给出能力分析。'
            : '尚未生成报告。先在「练习」页提交至少 5 题（当前 ' + history.length + ' 题），然后点击「生成报告」。'
        );

    if (local.report) reportBodyEl = body;

    root.appendChild(
      el('section', { class: 'report-view', 'data-report-view': '' }, toolbar, body),
    );
  }

  // ── PDF export ────────────────────────────────────────────────────
  async function exportPdf() {
    if (!reportBodyEl || local.exporting) return;
    local.exporting = true;
    render();
    try {
      const html2canvas = /** @type {any} */ (globalThis).html2canvas;
      const jsPDFCtor = /** @type {any} */ (globalThis).jspdf?.jsPDF
        ?? /** @type {any} */ (globalThis).jsPDF;
      if (typeof html2canvas !== 'function' || typeof jsPDFCtor !== 'function') {
        throw new Error('html2canvas / jsPDF 未加载');
      }
      // Match the page background so the PDF doesn't get a black canvas
      // from the body's radial gradient. Use the panel surface — easier
      // to read on a white printer.
      const canvas = await html2canvas(reportBodyEl, {
        backgroundColor: '#0e0e0e',
        scale: 2,
        useCORS: true,
        logging: false,
        windowWidth: reportBodyEl.scrollWidth,
        windowHeight: reportBodyEl.scrollHeight,
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDFCtor({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pageW = pdf.internal.pageSize.getWidth();   // 210
      const pageH = pdf.internal.pageSize.getHeight();  // 297
      // Scale the snapshot to fill the page width and paginate vertically.
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;
      let heightLeft = imgH;
      let y = 0;
      pdf.addImage(imgData, 'PNG', 0, y, imgW, imgH, undefined, 'FAST');
      heightLeft -= pageH;
      while (heightLeft > 0) {
        y -= pageH;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, y, imgW, imgH, undefined, 'FAST');
        heightLeft -= pageH;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      pdf.save(`sql-coach-report-${stamp}.pdf`);
    } catch (err) {
      // Surface the failure inline — the user wants to know if PDF can't
      // be produced rather than silently see a no-op.
      // eslint-disable-next-line no-alert
      alert(`PDF 导出失败：${String(err?.message ?? err)}`);
    } finally {
      local.exporting = false;
      render();
    }
  }

  return {
    mount(props = {}) {
      local.report  = props.report  ?? null;
      local.history = props.history ?? [];
      render();
    },
    update(props = {}) {
      if (props.report  !== undefined) local.report  = props.report;
      if (props.history !== undefined) local.history = props.history;
      render();
    },
    unmount() { clear(root); reportBodyEl = null; },
  };
}

// ── Report body composition ──────────────────────────────────────────

/** Build the report body — the snapshot target for PDF export. */
function buildReportBody(report, history) {
  // Always derive deterministic stats from history so the charts stay
  // truthful even if the AI section is empty / failed to parse.
  const stats = report?.stats?.byTopic
    ? report.stats
    : summariseHistory(history);

  const sections = [];

  // ── Overview ──────────────────────────────────────────────────────
  sections.push(buildOverviewSection(stats, report));

  // ── Difficulty distribution ───────────────────────────────────────
  sections.push(buildDifficultySection(stats));

  // ── Topic mastery bars ────────────────────────────────────────────
  sections.push(buildTopicMasterySection(stats));

  // ── AI multi-dimensional scores ───────────────────────────────────
  if (report?.scores?.length > 0) {
    sections.push(buildAiScoresSection(report.scores));
  } else if (report?.parseError) {
    sections.push(buildNoAiSection(report));
  }

  // ── Weak topics with advice ───────────────────────────────────────
  if (report?.weakTopics?.length > 0) {
    sections.push(buildWeakTopicsSection(report.weakTopics));
  }

  // ── Next-step recommendation ──────────────────────────────────────
  if (report?.recommendation) {
    sections.push(buildRecommendationSection(report.recommendation));
  }

  return el('div', { class: 'report-body', 'data-report-body': '' }, ...sections);
}

function buildOverviewSection(stats, report) {
  const total = stats.total ?? 0;
  const correct = stats.correctTotal ?? 0;
  const rate = total > 0 ? correct / total : 0;
  const topicCount = Object.keys(stats.byTopic ?? {}).length;
  const summaryLine = report?.summary
    ? el('p', { class: 'report-summary' }, report.summary)
    : null;
  return el('section', { class: 'report-section report-section-overview' },
    el('h3', { class: 'report-section-title' }, ZH.report.overview),
    el('div', { class: 'report-overview-grid' },
      buildStatCard('已完成', `${total}`, '题', null),
      buildStatCard('正确', `${correct}`, '题', rateBadge(rate)),
      buildStatCard('正确率', `${Math.round(rate * 100)}`, '%', null),
      buildStatCard('涉及知识点', `${topicCount}`, '个', null),
    ),
    summaryLine,
  );
}

function buildStatCard(label, big, unit, badge) {
  return el('div', { class: 'stat-card' },
    el('span', { class: 'stat-label' }, label),
    el('div', { class: 'stat-big-row' },
      el('span', { class: 'stat-big' }, big),
      el('span', { class: 'stat-unit' }, unit),
      badge,
    ),
  );
}

function buildDifficultySection(stats) {
  const rows = DIFFICULTY_LEVELS.map((lvl) => {
    const v = stats.byDifficulty?.[lvl] ?? { total: 0, correct: 0 };
    return svgBarRow({
      label: lvl,
      labelMeta: difficultyHint(lvl),
      value: v.correct,
      total: v.total,
    });
  });
  return el('section', { class: 'report-section' },
    el('h3', { class: 'report-section-title' }, ZH.report.difficultyDist),
    el('div', { class: 'report-bar-list' }, ...rows),
  );
}

function buildTopicMasterySection(stats) {
  const entries = Object.entries(stats.byTopic ?? {})
    .map(([id, v]) => ({ id, name: TOPIC_ZH[id] ?? id, ...v }))
    .sort((a, b) => b.total - a.total || b.correct - a.correct);
  if (entries.length === 0) {
    return el('section', { class: 'report-section' },
      el('h3', { class: 'report-section-title' }, ZH.report.topicMastery),
      el('p', { class: 'report-empty-mini' }, '暂无知识点数据。'),
    );
  }
  const rows = entries.map((t) => svgBarRow({
    label: t.name,
    value: t.correct,
    total: t.total,
  }));
  return el('section', { class: 'report-section' },
    el('h3', { class: 'report-section-title' }, ZH.report.topicMastery),
    el('div', { class: 'report-bar-list' }, ...rows),
  );
}

function buildAiScoresSection(scores) {
  return el('section', { class: 'report-section' },
    el('h3', { class: 'report-section-title' },
      ZH.report.aiScores,
      el('span', { class: 'report-section-tag' }, 'AI'),
    ),
    el('div', { class: 'report-score-grid' },
      ...scores.map((s) => buildScoreCard(s)),
    ),
  );
}

function buildScoreCard(s) {
  const rate = s.max > 0 ? s.score / s.max : 0;
  const tone = rateTone(rate);
  return el('div', { class: `score-card score-card-${tone}` },
    el('div', { class: 'score-card-head' },
      el('span', { class: 'score-card-name' }, s.name),
      el('span', { class: 'score-card-num' },
        el('strong', {}, String(s.score)),
        el('span', { class: 'score-card-max' }, ` / ${s.max}`),
      ),
    ),
    el('div', { class: 'score-card-bar-track' },
      el('div', { class: `score-card-bar score-card-bar-${tone}`, style: { width: `${rate * 100}%` } }),
    ),
    s.comment ? el('p', { class: 'score-card-comment' }, s.comment) : null,
  );
}

function buildWeakTopicsSection(weakTopics) {
  return el('section', { class: 'report-section' },
    el('h3', { class: 'report-section-title' },
      ZH.report.weakTopics,
      el('span', { class: 'report-section-tag' }, 'AI'),
    ),
    el('ol', { class: 'weak-topic-list' },
      ...weakTopics.map((w, i) => el('li', { class: 'weak-topic-item' },
        el('div', { class: 'weak-topic-head' },
          el('span', { class: 'weak-topic-rank' }, `#${i + 1}`),
          el('span', { class: 'weak-topic-name' }, w.name ?? w.id),
          el('span', { class: 'weak-topic-rate' }, `${Math.round((w.rate ?? 0) * 100)}%`),
        ),
        w.advice ? el('p', { class: 'weak-topic-advice' }, w.advice) : null,
      )),
    ),
  );
}

function buildRecommendationSection(text) {
  return el('section', { class: 'report-section report-section-reco' },
    el('h3', { class: 'report-section-title' },
      ZH.report.recommendation,
      el('span', { class: 'report-section-tag' }, 'AI'),
    ),
    el('p', { class: 'report-recommendation' }, text),
  );
}

function buildNoAiSection(report) {
  return el('section', { class: 'report-section report-section-noai' },
    el('p', { class: 'meta' }, ZH.report.noAi),
    report?.rawMarkdown
      ? el('pre', { class: 'report-raw-md' }, report.rawMarkdown)
      : null,
  );
}

// ── SVG bar primitives ───────────────────────────────────────────────

/** A horizontal bar row: [name][SVG track + fill][numeric label].
 *  All bars in a section share the same SVG width via flexbox so they
 *  align visually without pre-computing pixel widths. */
function svgBarRow({ label, labelMeta, value, total }) {
  const rate = total > 0 ? value / total : 0;
  const tone = total === 0 ? 'mute' : rateTone(rate);
  const NS = 'http://www.w3.org/2000/svg';
  // Use percentage widths inside the SVG so the chart scales with its
  // flex parent. viewBox 100x10 keeps math trivial.
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'bar-svg');
  svg.setAttribute('viewBox', '0 0 100 10');
  svg.setAttribute('preserveAspectRatio', 'none');
  const track = document.createElementNS(NS, 'rect');
  track.setAttribute('x', '0'); track.setAttribute('y', '2');
  track.setAttribute('width', '100'); track.setAttribute('height', '6');
  track.setAttribute('rx', '1');
  track.setAttribute('class', 'bar-track');
  const fill = document.createElementNS(NS, 'rect');
  fill.setAttribute('x', '0'); fill.setAttribute('y', '2');
  fill.setAttribute('width', String(rate * 100));
  fill.setAttribute('height', '6');
  fill.setAttribute('rx', '1');
  fill.setAttribute('class', `bar-fill bar-fill-${tone}`);
  svg.appendChild(track);
  svg.appendChild(fill);

  const ratioLabel = total === 0
    ? el('span', { class: 'bar-ratio bar-ratio-mute' }, '— / —')
    : el('span', { class: `bar-ratio bar-ratio-${tone}` }, `${value} / ${total}  ${Math.round(rate * 100)}%`);

  return el('div', { class: 'bar-row' },
    el('div', { class: 'bar-label' },
      el('span', { class: 'bar-label-text' }, label),
      labelMeta ? el('span', { class: 'bar-label-meta' }, labelMeta) : null,
    ),
    svg,
    ratioLabel,
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function rateTone(rate) {
  if (rate >= 0.7) return 'pass';
  if (rate >= 0.4) return 'warn';
  return 'fail';
}

function rateBadge(rate) {
  return el('span', { class: `rate-badge rate-badge-${rateTone(rate)}` },
    `${Math.round(rate * 100)}%`,
  );
}

function difficultyHint(lvl) {
  const hints = { L1: '入门', L2: '基础', L3: '进阶', L4: '挑战' };
  return hints[lvl] ?? '';
}

// ── Markdown synthesis (for the export-markdown button) ──────────────

function reportToMarkdown(report) {
  if (!report) return '';
  const lines = [];
  lines.push(`# SQL 学习能力报告`);
  lines.push('');
  if (report.summary) {
    lines.push(`> ${report.summary}`);
    lines.push('');
  }
  const stats = report.stats;
  if (stats) {
    lines.push(`**总览：** 已完成 ${stats.total ?? 0} 题，正确 ${stats.correctTotal ?? 0} 题`
      + (stats.total ? `，正确率 ${Math.round(((stats.correctTotal ?? 0) / stats.total) * 100)}%` : ''));
    lines.push('');
    lines.push(`## 难度分布`);
    lines.push('| 难度 | 题数 | 正确 | 正确率 |');
    lines.push('|---|---:|---:|---:|');
    for (const lvl of ['L1', 'L2', 'L3', 'L4']) {
      const v = stats.byDifficulty?.[lvl] ?? { total: 0, correct: 0 };
      const r = v.total > 0 ? `${Math.round((v.correct / v.total) * 100)}%` : '—';
      lines.push(`| ${lvl} | ${v.total} | ${v.correct} | ${r} |`);
    }
    lines.push('');
    lines.push(`## 知识点掌握度`);
    lines.push('| 知识点 | 题数 | 正确 | 正确率 |');
    lines.push('|---|---:|---:|---:|');
    const sorted = Object.entries(stats.byTopic ?? {})
      .map(([id, v]) => ({ id, name: TOPIC_ZH[id] ?? id, ...v }))
      .sort((a, b) => b.total - a.total);
    for (const t of sorted) {
      const r = t.total > 0 ? `${Math.round((t.correct / t.total) * 100)}%` : '—';
      lines.push(`| ${t.name} | ${t.total} | ${t.correct} | ${r} |`);
    }
    lines.push('');
  }
  if (report.scores?.length) {
    lines.push(`## 多维度能力评分（AI）`);
    lines.push('| 维度 | 评分 | 评语 |');
    lines.push('|---|---:|---|');
    for (const s of report.scores) {
      lines.push(`| ${s.name} | ${s.score} / ${s.max} | ${s.comment ?? ''} |`);
    }
    lines.push('');
  }
  if (report.weakTopics?.length) {
    lines.push(`## 薄弱点 · 重点突破（AI）`);
    for (const w of report.weakTopics) {
      lines.push(`- **${w.name ?? w.id}**（正确率 ${Math.round((w.rate ?? 0) * 100)}%）：${w.advice ?? ''}`);
    }
    lines.push('');
  }
  if (report.recommendation) {
    lines.push(`## 下一步建议（AI）`);
    lines.push(report.recommendation);
    lines.push('');
  }
  return lines.join('\n');
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
