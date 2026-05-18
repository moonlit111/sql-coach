// SQL 智学 application boot (Task 16.1).
//
// Validates: R1.5 (settings completeness gate), R4.2 (open index.html runs),
// R15.3 (restore most-recent schema and question bank from store),
// R17.2 (state-machine transitions across views).
//
// The boot sequence:
//   1. Probe localStorage; if disabled, render a banner.
//   2. Load settings via settings.load(). If !isComplete(cfg), render the
//      Settings view first; otherwise create Sandbox + LlmClient + graph.
//   3. Restore most-recent schema + question bank from the store (R15.3).
//   4. Render the Practice view by default; expose nav between
//      Practice / History / Settings / [OPT] Report.
//   5. Wire all views to the global app store (src/ui/app-store.js).
//
// This file is the only place that reaches into both the orchestrator and
// the persistence layer. Every UI view receives just the slice of state
// (and a small set of callbacks) it needs.

import { createAppStore } from './ui/app-store.js';
import { el, clear } from './ui/dom.js';
import { ZH } from './i18n/zh.js';

import * as settings from './settings/settings.js';
import { store } from './persist/store.js';
import { PersistKey } from './persist/schema.js';
import {
  loadLibrary, addToLibrary, removeFromLibrary, findInLibrary, splitDdlAndSeed,
} from './persist/schema-library.js';

import { createLlmClient } from './llm/client.js';
import { Sandbox } from './sandbox/sandbox.js';
import { createGraph } from './orchestrator/graph.js';
import { createInitialState, mergePartial, resetTutorForNewQuestion } from './orchestrator/state.js';

import { createSettingsView } from './ui/settings-view.js';
import { createPracticeView } from './ui/practice-view.js';
import { createDatabaseRouteView } from './ui/database-route.js';
import { createEditorView } from './ui/editor-view.js';
import { createDualEditorView } from './ui/dual-editor-view.js';
import { createResultView } from './ui/result-view.js';
import { createTutorView } from './ui/tutor-view.js';
import { createHistoryView, aggregateByQuestion } from './ui/history-view.js';
import { createReportView } from './ui/report-view.js';
import { renderQuotaDialog } from './ui/quota-dialog.js';
import { renderErrorToast } from './ui/error-toast.js';
import { createProgressDialog } from './ui/progress-dialog.js';

/**
 * @typedef {('practice'|'database'|'history'|'settings'|'report')} RouteName
 */

/**
 * Boot the app into the given root element. Returns an object with
 * lifecycle hooks so tests can drive the app deterministically.
 *
 * @param {HTMLElement} appRoot
 * @returns {Promise<{ appStore: ReturnType<typeof createAppStore>, navigate: (r: RouteName) => void, dispose: () => void }>}
 */
export async function boot(appRoot) {
  const cfg = settings.load();

  /** @type {{ route: RouteName, llm: any, schema: any, questions: any[], history: any[],
   *           question: any, verdict: any, userResult: any, tutorThread: any[],
   *           lastStoreOutcome: any, errors: any[], schemaSummary: any[]|null,
   *           awaitingTutor: boolean, busy: boolean,
   *           schemaLibrary: any[], activeDbId: string | null }} */
  const initialState = {
    route: settings.isComplete(cfg) ? 'practice' : 'settings', // R1.5
    llm: cfg ?? null,
    schema: store.get(PersistKey.CURRENT_SCHEMA),               // R15.3
    schemaSummary: null,
    schemaLibrary: loadLibrary(),
    activeDbId: null,
    focusedDbId: null,
    questions: store.get(PersistKey.QUESTION_BANK) ?? [],       // R15.3
    history: store.get(PersistKey.ANSWERS) ?? [],
    question: null,
    verdict: null,
    userResult: null,
    tutorThread: [],
    lastStoreOutcome: { ok: true },
    errors: [],
    awaitingTutor: false,
    busy: false,
  };
  if (initialState.schema && Array.isArray(initialState.schema.tables)) {
    initialState.schemaSummary = initialState.schema.tables;
    // If the boot schema matches a library entry by ddl, mark it active.
    const match = initialState.schemaLibrary.find(
      (r) => r.ddl === initialState.schema.ddl,
    );
    if (match) initialState.activeDbId = match.id;
  }
  const appStore = createAppStore(initialState);

  /** Wraps store.set so we can record the outcome for the quota dialog. */
  function safeSet(key, value) {
    const out = store.set(key, value);
    appStore.set({ lastStoreOutcome: out });
    return out;
  }

  /** Sandbox + LLM client + graph are only built once a complete config exists. */
  /** @type {Sandbox | null} */ let sandbox = null;
  /** @type {ReturnType<typeof createLlmClient> | null} */ let llmClient = null;
  /** @type {ReturnType<typeof createGraph> | null} */ let graph = null;
  /** @type {import('./orchestrator/state.js').AgentState | null} */ let agentState = null;
  /** Promise that resolves when any pending sandbox.loadSchema replay
   *  completes. We await this before running questionGen so the sandbox
   *  is guaranteed populated even if the user clicks 出题 immediately
   *  after a fresh page load. */
  /** @type {Promise<{ok:boolean, error?:string}> | null} */
  let sandboxReady = null;

  /** The LLM config object that was used to build the current llmClient.
   *  Compared by reference so we can detect when the user changes settings
   *  without relying solely on the Settings view's onSave callback. */
  let llmConfigRef = null;

  function ensureRuntime() {
    if (!settings.isComplete(appStore.state.llm)) return false;

    // Detect LLM config change — if the user's config object reference
    // differs from what we built the client with, force a rebuild of the
    // LLM client and graph (sandbox can be reused).
    if (sandbox && llmClient && graph && llmConfigRef !== appStore.state.llm) {
      llmClient = createLlmClient(appStore.state.llm);
      graph = createGraph({
        llmClient,
        sandbox,
        onProgress: (ev) => handleAgentProgress(ev),
      });
      llmConfigRef = appStore.state.llm;
    }

    if (sandbox && llmClient && graph) {
      // Keep agentState's snapshot of llm + schema in sync with appStore.
      // Without this, a fresh page load that restored schemaSummary from
      // localStorage would leave agentState empty, and the next click
      // on 「出题」 would bail with "缺少 schema".
      if (agentState) {
        const patch = {};
        if (agentState.llm !== appStore.state.llm) patch.llm = appStore.state.llm;
        if (agentState.schemaSummary !== appStore.state.schemaSummary) {
          patch.schemaSummary = appStore.state.schemaSummary;
        }
        if (Object.keys(patch).length > 0) {
          agentState = mergePartial(/** @type {any} */ (agentState), patch);
        }
      }
      return true;
    }
    sandbox = new Sandbox({ useWorker: false });
    llmClient = createLlmClient(appStore.state.llm);
    llmConfigRef = appStore.state.llm;
    graph = createGraph({
      llmClient,
      sandbox,
      onProgress: (ev) => handleAgentProgress(ev),
    });
    agentState = createInitialState({ llm: appStore.state.llm, theme: 'ecommerce' });
    // R15.3 — restored schema from localStorage must flow into agentState
    // AND be replayed into the sandbox so question-gen / judge / tutor can
    // actually execute SQL against it. The schema record stores ddl + seedSql.
    const persistedSchema = appStore.state.schema;
    if (persistedSchema && typeof persistedSchema === 'object'
        && typeof persistedSchema.ddl === 'string'
        && typeof persistedSchema.seedSql === 'string') {
      // Track the in-flight replay so onStartQuestion can await it.
      sandboxReady = sandbox.loadSchema(persistedSchema.ddl, persistedSchema.seedSql).then((r) => {
        if (!r.ok) {
          pushError({
            kind: 'sandbox_runtime',
            message: `恢复保存的数据库失败：${r.error ?? 'unknown'}。请重新生成数据集。`,
          });
        }
        return r;
      });
    }
    if (appStore.state.schemaSummary) {
      agentState = mergePartial(/** @type {any} */ (agentState), {
        schemaSummary: appStore.state.schemaSummary,
      });
    }
    return true;
  }

  // ── Progress dialog plumbing ────────────────────────────────────────
  // Each agent (SchemaGen, QuestionGen) sends step-by-step progress events
  // through `graph.onProgress`. We translate them into a small step list
  // shown in a modal so users see exactly which retry attempt is in flight
  // and which validation step failed.
  /** @type {ReturnType<typeof createProgressDialog> | null} */
  let progressDialog = null;
  /** @type {Record<string, import('./ui/progress-dialog.js').ProgressStep>} */
  let progressSteps = {};
  /** @type {string[]} */
  let progressOrder = [];

  /** Reset progress state and show a fresh dialog. */
  function openProgressDialog(title, plannedSteps) {
    progressSteps = {};
    progressOrder = [];
    for (const s of plannedSteps) {
      progressOrder.push(s.id);
      progressSteps[s.id] = { ...s };
    }
    progressDialog = createProgressDialog({
      root: dialogContainer,
      title,
      onClose: () => { progressDialog = null; },
    });
    progressDialog.update({
      steps: progressOrder.map((id) => progressSteps[id]),
      overall: 'running',
    });
    progressDialog.mount();
  }

  function closeProgressDialog() {
    progressDialog?.close();
    progressDialog = null;
  }

  function failProgressDialog(detail) {
    if (!progressDialog) return;
    progressDialog.fail(detail);
  }

  /** When QuestionGen exhausts retries with the specific "empty result"
   *  failure mode, swap the plain error message for a friendlier
   *  diagnostic + a row of recovery actions. The user lands here when
   *  they probably need to either widen the input (more knowledge
   *  topics ≠ more matches; usually fewer + a different DB helps) or
   *  regenerate the dataset entirely.
   *
   *  @param {{ error?: string, errorContext?: any }} next
   */
  function failQuestionGenWithHints(next) {
    if (!progressDialog) return;
    const ctx = next.errorContext ?? {};
    const tables = Array.isArray(ctx.tables) ? ctx.tables : [];
    const tableSummary = tables.length
      ? tables.map((t) => `  · ${t.name}：${t.rows} 行`).join('\n')
      : '  · 未识别出涉及的表';
    const dataDiagnosis = tables.length === 0 || tables.every((t) => t.rows === 0)
      ? '所有相关的表本身就是空的或没识别出来 —— 强烈建议重新生成数据集。'
      : '相关表里有数据，但 WHERE / HAVING / JOIN 把所有行都过滤掉了。\n通常是题目要求与数据集不匹配（比如要求统计某个不存在的分类）。';
    const message =
      `连续 ${ctx.emptyAttempts ?? '多'} 次生成的参考 SQL 都返回 0 行，无法作为练习题。\n\n`
      + `涉及的表：\n${tableSummary}\n\n`
      + `${dataDiagnosis}\n\n`
      + `下面几个动作可以快速恢复：`;
    progressDialog.fail({
      message,
      actions: [
        {
          label: '前往「数据库」页',
          variant: 'primary',
          onClick: () => navigate('database'),
        },
        {
          label: '关闭并减少知识点',
          onClick: () => { /* dialog already closed by the helper */ },
        },
      ],
    });
  }

  function succeedProgressDialog(msg) {
    if (!progressDialog) return;
    progressDialog.succeed(msg);
    // Auto-close after 800ms so users see the green check briefly.
    setTimeout(() => closeProgressDialog(), 800);
  }

  // Map of (node.phase) -> step id used in the dialog. Two nodes share the
  // same phase names; the node prefix disambiguates them.
  const PHASE_LABELS = {
    'schemaGen.llm':     '调用模型生成 DDL',
    'schemaGen.parse':   '解析模型返回的 JSON',
    'schemaGen.safety':  '安全过滤（禁用 AUTOINCREMENT 等）',
    'schemaGen.sandbox': '在沙箱中执行 DDL+种子数据',
    'schemaGen.verify':  '校验表数量、外键、行数',
    'questionGen.restore': '恢复已保存的数据库（如果有）',
    'questionGen.llm':     '调用模型生成题目',
    'questionGen.parse':   '解析模型返回的 JSON',
    'questionGen.validate':'校验难度、知识点、排序',
    'questionGen.sandbox': '在沙箱中验证参考 SQL',
    'reporter.llm':        '调用模型分析历史记录',
  };

  function handleAgentProgress(ev) {
    const key = `${ev.node}.${ev.phase}`;
    const label = PHASE_LABELS[key] ?? key;
    if (!progressSteps[ev.phase]) {
      // The plannedSteps list ensures order; if a phase shows up that we
      // didn't pre-plan, append it.
      progressOrder.push(ev.phase);
      progressSteps[ev.phase] = { id: ev.phase, label, status: 'pending' };
    }
    const step = progressSteps[ev.phase];
    step.label = label;
    // Encode attempt # in detail for retries.
    step.status = ev.status;
    step.detail = ev.detail
      ? (ev.attempt > 1 ? `[尝试 ${ev.attempt}] ${ev.detail}` : ev.detail)
      : (ev.attempt > 1 ? `[尝试 ${ev.attempt}]` : undefined);
    progressDialog?.update({ steps: progressOrder.map((id) => progressSteps[id]) });
  }

  // ── Layout: app shell with nav + per-route container. ───────────────
  clear(appRoot);
  const navContainer = el('nav', { class: 'app-nav', 'data-app-nav': '' });
  const routeContainer = el('main', { class: 'app-route', 'data-app-route': '' });
  const dialogContainer = el('div', { class: 'app-dialog', 'data-app-dialog': '' });
  const toastContainer = el('div', { class: 'app-toast', 'data-app-toast': '' });
  appRoot.appendChild(
    el('header', {},
      el('h1', {}, 'SQL_COACH'),
      navContainer,
      el('div', {
        'data-model-label': '',
        style: {
          fontSize: 'var(--fs-xs)',
          color: 'var(--tx-3)',
          marginLeft: 'auto',
        },
      }, appStore.state.llm?.modelName ?? 'no model'),
    ),
  );
  appRoot.appendChild(routeContainer);
  appRoot.appendChild(dialogContainer);
  appRoot.appendChild(toastContainer);

  // localStorage banner (R2.5).
  if (store.usingFallback) {
    appRoot.insertBefore(
      el(
        'div',
        {
          class: 'storage-fallback-banner',
          'data-storage-banner': '',
          style: {
            backgroundColor: '#fff3cd',
            color: '#856404',
            padding: '8px 12px',
          },
        },
        '提示：浏览器禁用了 localStorage，本会话的数据将仅保存在内存中。',
      ),
      navContainer,
    );
  }

  // ── Route definitions. Each entry creates the view lazily on first nav. ──
  /** @type {Partial<Record<RouteName, { mount: (p?: any) => void, update?: (p?: any) => void, unmount?: () => void }>>} */
  const views = {};

  function buildView(route) {
    switch (route) {
      case 'settings':
        return createSettingsView({
          root: routeContainer,
          onSave: (newCfg, outcome = { ok: true }) => {
            if (!outcome.ok) {
              appStore.set({ lastStoreOutcome: outcome });
              return;
            }
            appStore.set({ llm: newCfg, route: 'practice', lastStoreOutcome: outcome });
            sandbox = null; llmClient = null; graph = null; // force rebuild
          },
          onClear: () => { appStore.set({ llm: null, route: 'settings' }); },
        });
      case 'practice':
        return buildPracticeView();
      case 'database':
        return buildDatabaseRoute();
      case 'history':
        return createHistoryView({
          root: routeContainer,
          store,
          onRedo: (record) => redoFromHistory(record),
          onClear: () => { appStore.set({ history: [] }); },
        });
      case 'report':
        return createReportView({
          root: routeContainer,
          onGenerate: () => generateReport(),
        });
    }
  }

  /** Friendly label for a generated database, derived from the theme key. */
  function themeLabel(theme, desc) {
    const map = {
      ecommerce: '电商',
      campus:    '校园',
      library:   '图书馆',
      hospital:  '医院',
      custom:    '自定义',
    };
    const base = map[theme] ?? String(theme);
    if (theme === 'custom' && desc) {
      return `自定义：${desc.slice(0, 16)}`;
    }
    return `${base} · ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
  }

  function buildPracticeView() {
    return createPracticeView({
      root: routeContainer,
      dialogRoot: dialogContainer,
      onGoToDatabaseTab: () => navigate('database'),
      onToggleRefSql: () => {
        // Ref answer is now shown inline in the question card.
        // No need to mirror to tutor view.
      },
      getHistoryQuestions: () => {
        // Aggregate by questionId so each historical question appears
        // exactly once with its tri-state status (correct/recovered/wrong)
        // attached. Most recently touched first. Each entry exposes the
        // latest attempt's denormalised fields (prompt/topics/db) plus a
        // `status` for colour-coding in the modal.
        const history = appStore.state.history ?? [];
        const aggregates = aggregateByQuestion(history);
        return aggregates
          .sort((a, b) => (b.latestSubmittedAt ?? 0) - (a.latestSubmittedAt ?? 0))
          .map((q) => {
            const ref = q.lastAttempt ?? {};
            return {
              ...ref,
              status:        q.status,
              attemptsCount: q.attempts.length,
              correctCount:  q.correctCount,
              wrongCount:    q.wrongCount,
            };
          });
      },
      onSelectHistoryQuestion: (record) => redoFromHistory(record),
      onStartQuestion: async (difficulty, topics) => {
        if (!ensureRuntime()) return;
        appStore.set({ busy: true });
        openProgressDialog('正在生成题目…', [
          { id: 'restore',  label: '恢复已保存的数据库（如果有）',  status: 'pending' },
          { id: 'llm',      label: '调用模型生成题目',          status: 'pending' },
          { id: 'parse',    label: '解析模型返回的 JSON',        status: 'pending' },
          { id: 'validate', label: '校验难度、知识点、排序',     status: 'pending' },
          { id: 'sandbox',  label: '在沙箱中验证参考 SQL',       status: 'pending' },
        ]);

        if (sandboxReady) {
          handleAgentProgress({ node: 'questionGen', phase: 'restore', attempt: 1, status: 'running' });
          const r = await sandboxReady;
          if (!r.ok) {
            failProgressDialog(`恢复数据库失败：${r.error ?? 'unknown'}`);
            appStore.set({ busy: false });
            return;
          }
          handleAgentProgress({ node: 'questionGen', phase: 'restore', attempt: 1, status: 'ok' });
          sandboxReady = null;
        } else {
          handleAgentProgress({ node: 'questionGen', phase: 'restore', attempt: 1, status: 'ok', detail: '无需恢复' });
        }

        agentState = mergePartial(/** @type {any} */ (agentState), {
          requestedDifficulty: difficulty,
          requestedTopics: topics,
          schemaSummary: appStore.state.schemaSummary ?? agentState?.schemaSummary,
        });

        if (!agentState.schemaSummary) {
          failProgressDialog('请先在「数据库」选项卡生成或选择一个数据库后再出题。');
          appStore.set({ busy: false });
          return;
        }

        const next = await graph.runNode('questionGen', /** @type {any} */ (agentState));
        agentState = next;
        if (next.failedAgent) {
          const detail = String(next.error ?? '未知错误');
          if (next.errorKind === 'empty_results_exhausted') {
            // Specialised UI: dialog with action buttons that route the
            // user toward the actual fix (switch DB / reduce topics).
            failQuestionGenWithHints(next);
          } else {
            failProgressDialog(`生成失败：${detail}`);
          }
          pushError({ kind: 'bad_response', message: `QuestionGen 失败：${detail}` });
        } else {
          appStore.set({ question: next.question, verdict: null, userResult: null, tutorThread: [] });
          editorDraft = { single: '', set: '', join: '' };
          remountEditor();
          const bank = appStore.state.questions.slice();
          bank.push(next.question);
          safeSet(PersistKey.QUESTION_BANK, bank);
          appStore.set({ questions: bank });
          succeedProgressDialog('题目就绪');
        }
        appStore.set({ busy: false });
      },
      onCustomQuestion: async (customPrompt) => {
        if (!ensureRuntime()) return;
        appStore.set({ busy: true });
        openProgressDialog('正在根据自定义提示生成题目…', [
          { id: 'restore',  label: '恢复已保存的数据库（如果有）',  status: 'pending' },
          { id: 'llm',      label: '调用模型生成题目',          status: 'pending' },
          { id: 'parse',    label: '解析模型返回的 JSON',        status: 'pending' },
          { id: 'validate', label: '校验难度、知识点、排序',     status: 'pending' },
          { id: 'sandbox',  label: '在沙箱中验证参考 SQL',       status: 'pending' },
        ]);

        if (sandboxReady) {
          handleAgentProgress({ node: 'questionGen', phase: 'restore', attempt: 1, status: 'running' });
          const r = await sandboxReady;
          if (!r.ok) {
            failProgressDialog(`恢复数据库失败：${r.error ?? 'unknown'}`);
            appStore.set({ busy: false });
            return;
          }
          handleAgentProgress({ node: 'questionGen', phase: 'restore', attempt: 1, status: 'ok' });
          sandboxReady = null;
        } else {
          handleAgentProgress({ node: 'questionGen', phase: 'restore', attempt: 1, status: 'ok', detail: '无需恢复' });
        }

        agentState = mergePartial(/** @type {any} */ (agentState), {
          requestedDifficulty: 'L2',
          requestedTopics: [],
          customPrompt,
          schemaSummary: appStore.state.schemaSummary ?? agentState?.schemaSummary,
        });

        if (!agentState.schemaSummary) {
          failProgressDialog('请先在「数据库」选项卡生成或选择一个数据库后再出题。');
          appStore.set({ busy: false });
          return;
        }

        const next = await graph.runNode('questionGen', /** @type {any} */ (agentState));
        agentState = next;
        // Clear customPrompt from state after use.
        agentState = mergePartial(/** @type {any} */ (agentState), { customPrompt: undefined });
        if (next.failedAgent) {
          const detail = String(next.error ?? '未知错误');
          if (next.errorKind === 'empty_results_exhausted') {
            failQuestionGenWithHints(next);
          } else {
            failProgressDialog(`生成失败：${detail}`);
          }
          pushError({ kind: 'bad_response', message: `QuestionGen 失败：${detail}` });
        } else {
          appStore.set({ question: next.question, verdict: null, userResult: null, tutorThread: [] });
          editorDraft = { single: '', set: '', join: '' };
          remountEditor();
          const bank = appStore.state.questions.slice();
          bank.push(next.question);
          safeSet(PersistKey.QUESTION_BANK, bank);
          appStore.set({ questions: bank });
          succeedProgressDialog('题目就绪');
        }
        appStore.set({ busy: false });
      },
    });
  }

  function buildDatabaseRoute() {
    return createDatabaseRouteView({
      root: routeContainer,
      onGenerate: async (theme, themeDescription) => {
        if (!ensureRuntime()) return;
        appStore.set({ busy: true });
        openProgressDialog('正在生成数据库…', [
          { id: 'llm',     label: '调用模型生成 DDL',          status: 'pending' },
          { id: 'parse',   label: '解析模型返回的 JSON',        status: 'pending' },
          { id: 'safety',  label: '安全过滤（禁用 AUTOINCREMENT 等）', status: 'pending' },
          { id: 'sandbox', label: '在沙箱中执行 DDL+种子数据',  status: 'pending' },
          { id: 'verify',  label: '校验表数量、外键、行数',     status: 'pending' },
        ]);
        agentState = mergePartial(/** @type {any} */ (agentState), { theme, themeDescription });
        const next = await graph.runNode('schemaGen', /** @type {any} */ (agentState));
        agentState = next;
        if (next.failedAgent) {
          const detail = String(next.error ?? '未知错误');
          failProgressDialog(`生成失败：${detail}`);
          pushError({ kind: 'bad_response', message: `SchemaGen 失败：${detail}` });
        } else {
          const { record } = addToLibrary({
            name: themeLabel(theme, themeDescription),
            ddl: next.ddl,
            seedSql: next.seedSql,
            tables: next.schemaSummary,
            source: 'generated',
          });
          appStore.set({
            schemaSummary: next.schemaSummary,
            schema: { ddl: next.ddl, seedSql: next.seedSql, tables: next.schemaSummary },
            schemaLibrary: loadLibrary(),
            activeDbId: record.id,
            focusedDbId: record.id,
          });
          safeSet(PersistKey.CURRENT_SCHEMA, { ddl: next.ddl, seedSql: next.seedSql, tables: next.schemaSummary, createdAt: Date.now() });
          sandboxReady = null;
          succeedProgressDialog(`成功生成 ${next.schemaSummary.length} 张表`);
        }
        appStore.set({ busy: false });
      },
      onImport: async (file) => {
        if (!ensureRuntime()) return;
        appStore.set({ busy: true });
        openProgressDialog('正在导入数据库…', [
          { id: 'read',    label: '读取 .sql 文件',            status: 'pending' },
          { id: 'split',   label: '拆分 DDL 与种子数据',        status: 'pending' },
          { id: 'sandbox', label: '在沙箱中执行 DDL+种子数据',  status: 'pending' },
          { id: 'verify',  label: '提取表结构',                 status: 'pending' },
        ]);
        try {
          handleAgentProgress({ node: 'import', phase: 'read', attempt: 1, status: 'running', detail: file.name });
          const text = await file.text();
          handleAgentProgress({ node: 'import', phase: 'read', attempt: 1, status: 'ok', detail: `${text.length} 字符` });

          handleAgentProgress({ node: 'import', phase: 'split', attempt: 1, status: 'running' });
          const { ddl, seedSql } = splitDdlAndSeed(text);
          if (!ddl) {
            failProgressDialog('文件中找不到任何 SQL 语句。');
            appStore.set({ busy: false });
            return;
          }
          handleAgentProgress({ node: 'import', phase: 'split', attempt: 1, status: 'ok',
            detail: `DDL ${ddl.length} 字符，种子 ${seedSql.length} 字符` });

          handleAgentProgress({ node: 'import', phase: 'sandbox', attempt: 1, status: 'running' });
          const r = await sandbox.loadSchema(ddl, seedSql);
          if (!r.ok) {
            handleAgentProgress({ node: 'import', phase: 'sandbox', attempt: 1, status: 'fail', detail: r.error });
            failProgressDialog(`沙箱执行失败：${r.error}`);
            appStore.set({ busy: false });
            return;
          }
          handleAgentProgress({ node: 'import', phase: 'sandbox', attempt: 1, status: 'ok' });

          handleAgentProgress({ node: 'import', phase: 'verify', attempt: 1, status: 'running' });
          const tables = sandbox.describeSchema();
          handleAgentProgress({ node: 'import', phase: 'verify', attempt: 1, status: 'ok',
            detail: `${tables.length} 张表` });

          const { record } = addToLibrary({
            name: file.name.replace(/\.sql$/i, '') || `导入 ${new Date().toLocaleString('zh-CN')}`,
            ddl, seedSql, tables, source: 'imported',
          });
          appStore.set({
            schemaSummary: tables,
            schema: { ddl, seedSql, tables },
            schemaLibrary: loadLibrary(),
            activeDbId: record.id,
            focusedDbId: record.id,
          });
          safeSet(PersistKey.CURRENT_SCHEMA, { ddl, seedSql, tables, createdAt: Date.now() });
          agentState = mergePartial(/** @type {any} */ (agentState), { schemaSummary: tables });
          sandboxReady = null;
          succeedProgressDialog(`已导入「${record.name}」`);
        } catch (e) {
          failProgressDialog(`导入失败：${String(e?.message ?? e)}`);
        }
        appStore.set({ busy: false });
      },
      onSelect: async (id) => {
        if (!ensureRuntime()) return;
        const rec = findInLibrary(id);
        if (!rec) {
          pushError({ kind: 'persist_error', message: `数据库 ${id} 不存在` });
          return;
        }
        appStore.set({ busy: true });
        openProgressDialog('正在切换数据库…', [
          { id: 'sandbox', label: '在沙箱中加载 DDL+种子数据', status: 'pending' },
        ]);
        handleAgentProgress({ node: 'select', phase: 'sandbox', attempt: 1, status: 'running' });
        const r = await sandbox.loadSchema(rec.ddl, rec.seedSql);
        if (!r.ok) {
          handleAgentProgress({ node: 'select', phase: 'sandbox', attempt: 1, status: 'fail', detail: r.error });
          failProgressDialog(`加载失败：${r.error}`);
          appStore.set({ busy: false });
          return;
        }
        handleAgentProgress({ node: 'select', phase: 'sandbox', attempt: 1, status: 'ok' });
        const tables = sandbox.describeSchema();
        appStore.set({
          schemaSummary: tables,
          schema: { ddl: rec.ddl, seedSql: rec.seedSql, tables },
          activeDbId: rec.id,
          focusedDbId: rec.id,
        });
        safeSet(PersistKey.CURRENT_SCHEMA, { ddl: rec.ddl, seedSql: rec.seedSql, tables, createdAt: Date.now() });
        agentState = mergePartial(/** @type {any} */ (agentState), { schemaSummary: tables });
        sandboxReady = null;
        succeedProgressDialog(`已切换到「${rec.name}」`);
        appStore.set({ busy: false });
      },
      onDelete: (id) => {
        const isActive = appStore.state.activeDbId === id;
        removeFromLibrary(id);
        const next = { schemaLibrary: loadLibrary() };
        if (isActive) next.activeDbId = null;
        if (appStore.state.focusedDbId === id) next.focusedDbId = null;
        appStore.set(next);
      },
      onFocus: (id) => { appStore.set({ focusedDbId: id }); },
    });
  }

  /**
   * Re-create a `Question` object from a denormalised AnswerRecord and
   * push it into the practice tab. If the record references a saved
   * database that is no longer the active one, switch to it first
   * (loadSchema replays the DDL into the sandbox).
   *
   * @param {any} record
   */
  async function redoFromHistory(record) {
    if (!record) return;
    if (!ensureRuntime()) return;

    // Switch to the source database when needed.
    if (record.databaseId && record.databaseId !== appStore.state.activeDbId) {
      const rec = findInLibrary(record.databaseId);
      if (rec) {
        appStore.set({ busy: true });
        const r = await sandbox.loadSchema(rec.ddl, rec.seedSql);
        if (!r.ok) {
          pushError({ kind: 'sandbox_runtime', message: `重做失败：无法加载源数据库 (${r.error})` });
          appStore.set({ busy: false });
          return;
        }
        const tables = sandbox.describeSchema();
        appStore.set({
          schemaSummary: tables,
          schema: { ddl: rec.ddl, seedSql: rec.seedSql, tables },
          activeDbId: rec.id,
          focusedDbId: rec.id,
        });
        safeSet(PersistKey.CURRENT_SCHEMA, { ddl: rec.ddl, seedSql: rec.seedSql, tables, createdAt: Date.now() });
        agentState = mergePartial(/** @type {any} */ (agentState), { schemaSummary: tables });
        sandboxReady = null;
        appStore.set({ busy: false });
      } else {
        pushError({ kind: 'persist_error', message: '源数据库已被删除，无法重做。' });
        return;
      }
    }

    // The boot path may still be replaying the persisted DDL into the
    // sandbox. We MUST wait for that to finish; otherwise exec'ing the
    // refSql below would return "no database loaded" and the synthesised
    // expectedResult would be empty — every subsequent submission would
    // be judged "wrong" no matter what the user types.
    if (sandboxReady) {
      const r = await sandboxReady;
      if (!r.ok) {
        pushError({ kind: 'sandbox_runtime', message: `重做失败：${r.error ?? '无法恢复数据库'}` });
        return;
      }
      sandboxReady = null;
    }

    // Guard: if the sandbox has no loaded database at all (e.g. fresh
    // runtime with no persisted schema), exec will fail. Bail early with
    // a clear message rather than showing a cryptic sandbox error.
    const tables = sandbox.describeSchema?.();
    if (!tables || (Array.isArray(tables) && tables.length === 0)) {
      pushError({ kind: 'sandbox_runtime', message: '重做失败：当前没有加载任何数据库，请先在「数据库」页选择或生成数据集。' });
      return;
    }

    // Restore the question. We synthesise a Question from the denormalised
    // fields; expectedResult will be re-derived by re-running refSql.
    /** @type {import('./types.js').Question} */
    const question = {
      id: record.questionId ?? `redo-${Date.now()}`,
      createdAt: Date.now(),
      difficulty: record.questionDifficulty ?? 'L1',
      topics:     record.questionTopics ?? [],
      prompt:     record.questionPrompt ?? '（题面缺失）',
      refSql:     record.questionRefSql ?? '',
      refSqlAlt:  record.questionRefSqlAlt ?? undefined,
      expectedResult: { columns: [], rows: [] }, // recomputed below
      isOrdered:  Boolean(record.questionIsOrdered),
      schemaRef:  record.databaseId ?? 'current',
    };
    if (!question.refSql) {
      pushError({ kind: 'persist_error', message: '历史记录缺少参考 SQL，无法重做。' });
      return;
    }
    // Re-execute refSql to refresh expectedResult so the new submission
    // can be judged against the live database.
    const rs = await sandbox.exec(question.refSql, { allowDml: false });
    if (!rs || rs.kind || !Array.isArray(rs.rows)) {
      pushError({
        kind: 'sandbox_runtime',
        message: `重做失败：参考 SQL 执行错误（${rs?.message ?? rs?.kind ?? '未知'}）`,
      });
      return;
    }
    question.expectedResult = rs;

    appStore.set({
      question,
      verdict: null,
      userResult: null,
      tutorThread: [],
    });
    editorDraft = {
      single: record.userSql ?? '',
      set:    record.userSql ?? '',
      join:   record.userSqlAlt ?? '',
    };
    navigate('practice');
    // The freshly mounted editor needs a remount so the dual/single
    // layout matches the question's topics.
    queueMicrotask(() => remountEditor());
  }

  async function generateReport() {
    if (!ensureRuntime()) return;
    appStore.set({ busy: true });
    openProgressDialog('正在生成能力报告…', [
      { id: 'llm', label: '调用模型分析历史记录', status: 'pending' },
    ]);
    // Reporter doesn't currently emit progress events but show a spinner-equivalent.
    handleAgentProgress({ node: 'reporter', phase: 'llm', attempt: 1, status: 'running', detail: '请稍候，模型正在生成 Markdown 报告' });
    const reportState = agentState ?? createInitialState({ llm: appStore.state.llm, theme: 'ecommerce' });
    const next = await graph.runNode('reporter', /** @type {any} */ (mergePartial(/** @type {any} */ (reportState), { history: appStore.state.history ?? [] })));
    if (next.failedAgent) {
      const detail = String(next.error ?? '未知错误');
      failProgressDialog(`生成失败：${detail}`);
      pushError({ kind: 'bad_response', message: `Reporter 失败：${detail}` });
    } else {
      const reportLen = (next.report?.summary?.length ?? 0)
        + (next.report?.scores?.length ?? 0) * 20;
      handleAgentProgress({ node: 'reporter', phase: 'llm', attempt: 1, status: 'ok', detail: `报告 ${reportLen} 字符` });
      appStore.set({ report: next.report });
      succeedProgressDialog('报告就绪');
    }
    appStore.set({ busy: false });
  }

  function pushError(err) {
    const errs = [...appStore.state.errors, err];
    appStore.set({ errors: errs });
  }

  function clearErrors() { appStore.set({ errors: [] }); }

  // ── Routing. ────────────────────────────────────────────────────────
  function navigate(route) {
    const prev = appStore.state.route;
    if (prev && views[prev] && views[prev].unmount) views[prev].unmount();
    clear(routeContainer);
    appStore.set({ route });
    if (!views[route]) views[route] = buildView(route);
    mountCurrent();
  }

  function mountCurrent() {
    const route = appStore.state.route;
    const view = views[route];
    if (!view) return;
    switch (route) {
      case 'settings': view.mount({ cfg: appStore.state.llm }); break;
      case 'practice':
        view.mount({
          activeDbId: appStore.state.activeDbId,
          activeDbName: activeDbNameFromStore(),
          question: appStore.state.question,
        });
        // Mount editor + result + tutor into the freshly-rendered placeholders.
        mountPracticePanes();
        break;
      case 'database':
        view.mount({
          library: appStore.state.schemaLibrary,
          activeDbId: appStore.state.activeDbId,
          focusedDbId: appStore.state.focusedDbId,
        });
        break;
      case 'history':
        view.mount({ records: appStore.state.history });
        break;
      case 'report':
        view.mount({
          report: appStore.state.report ?? null,
          history: appStore.state.history ?? [],
        });
        break;
    }
  }

  /** Helper — derive the active database's display name for headers. */
  function activeDbNameFromStore() {
    const id = appStore.state.activeDbId;
    if (!id) return '';
    const rec = (appStore.state.schemaLibrary ?? []).find((r) => r.id === id);
    return rec ? rec.name : '';
  }

  /** Mount editor + result + tutor panes into the freshly-rendered practice view. */
  function mountPracticePanes() {
    const editorMount = routeContainer.querySelector('[data-editor-mount]');
    const resultMount = routeContainer.querySelector('[data-result-mount]');
    const tutorMount  = routeContainer.querySelector('[data-tutor-mount]');
    if (editorMount && editorMount.children.length === 0) mountEditorPane(editorMount);
    if (resultMount && resultMount.children.length === 0) mountResultPane(resultMount);
    if (tutorMount  && tutorMount.children.length === 0)  mountTutorPane(tutorMount);
    // Always update mounted views with latest state. Critically, push
    // `busy` into the editor so the Submit button re-enables once the
    // judge/tutor turn finishes (R12.6 doesn't disable submission post-
    // verdict — users must be able to retry on a wrong answer).
    if (editorView) editorView.update({
      busy: appStore.state.busy,
      schema: appStore.state.schemaSummary ?? null,
    });
    if (resultView) resultView.update({
      result: appStore.state.userResult ?? null,
      verdict: appStore.state.verdict ?? null,
      expectedResult: appStore.state.question?.expectedResult ?? null,
    });
    if (tutorView) tutorView.update({
      thread: appStore.state.tutorThread ?? [],
      awaitingReply: appStore.state.awaitingTutor,
      verdictState: appStore.state.verdict
        ? (appStore.state.verdict.correct ? 'correct' : 'wrong')
        : 'none',
    });
  }

  /** Force a remount of the editor when single↔dual changes (driven by new question). */
  function remountEditor() {
    const mount = routeContainer.querySelector('[data-editor-mount]');
    if (!mount) return;
    clear(mount);
    mountEditorPane(mount);
  }

  /**
   * Submit the user's SQL: run Judge → append AnswerRecord → if wrong,
   * trigger Tutor.firstMessage with the diff/refSql context.
   */
  async function submitUserSql(userSql, userSqlAlt) {
    if (!ensureRuntime()) return;
    const q = appStore.state.question;
    if (!q) return;

    appStore.set({ busy: true });
    agentState = mergePartial(/** @type {any} */ (agentState), {
      question: q,
      userSql,
      userSqlAlt,
      // Reset thread so Tutor starts fresh per submission per R13.5.
      tutorThread: [],
    });

    const judged = await graph.runNode('judge', /** @type {any} */ (agentState));
    agentState = judged;

    if (judged.failedAgent) {
      pushError({ kind: 'sandbox_runtime', message: `Judge 失败：${judged.error}` });
      appStore.set({ busy: false });
      return;
    }

    appStore.set({
      verdict: judged.verdict ?? null,
      userResult: judged.userResult ?? null,
    });

    // Persist as an AnswerRecord (R15.1 / R15.2).
    // Denormalise question + database info so the history view can show
    // the full context (prompt / topics / db name) without re-joining the
    // question bank — those entries can be rotated/cleared independently.
    const dbId = appStore.state.activeDbId ?? null;
    const dbRec = dbId
      ? (appStore.state.schemaLibrary ?? []).find((r) => r.id === dbId) ?? null
      : null;
    /** @type {import('./types.js').AnswerRecord} */
    const record = {
      id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      questionId: q.id,
      submittedAt: Date.now(),
      userSql,
      userSqlAlt,
      verdict: judged.verdict ?? { correct: false },
      tutorThread: [],
      // Denormalised snapshot:
      questionPrompt:     q.prompt,
      questionDifficulty: q.difficulty,
      questionTopics:     q.topics ?? [],
      questionRefSql:     q.refSql,
      questionRefSqlAlt:  q.refSqlAlt ?? null,
      questionIsOrdered:  Boolean(q.isOrdered),
      databaseId:   dbId,
      databaseName: dbRec?.name ?? '',
    };
    const history = [...(appStore.state.history ?? []), record];
    safeSet(PersistKey.ANSWERS, history);
    appStore.set({ history });

    // R12.6 / R13.1 — every submission triggers Tutor.firstMessage (在线问答).
    appStore.set({ awaitingTutor: true });
    const tutored = await graph.runNode('tutor.firstMessage', /** @type {any} */ (agentState));
    agentState = tutored;
    if (tutored.failedAgent) {
      pushError({ kind: 'bad_response', message: `Tutor 失败：${tutored.error}` });
    } else {
      appStore.set({ tutorThread: tutored.tutorThread ?? [] });
    }
    appStore.set({ awaitingTutor: false });

    appStore.set({ busy: false });
  }

  /** Mount the SQL editor into a placeholder. set_vs_join_compare uses dual editor. */
  let editorView = null;
  /** Cache the in-progress draft SQL across re-renders so the user doesn't lose work. */
  let editorDraft = { single: '', set: '', join: '' };
  function mountEditorPane(target) {
    const q = appStore.state.question;
    const isDual = !!q && Array.isArray(q.topics) && q.topics.includes('set_vs_join_compare');
    if (isDual) {
      editorView = createDualEditorView({
        root: target,
        onSubmit: (sqlSet, sqlJoin) => {
          editorDraft.set = sqlSet;
          editorDraft.join = sqlJoin;
          submitUserSql(sqlSet, sqlJoin);
        },
        onChange: (sqlSet, sqlJoin) => {
          editorDraft.set = sqlSet;
          editorDraft.join = sqlJoin;
        },
        onReset: () => {
          if (sandbox) sandbox.resetToBaseline();
          pushInfo('数据库已重置到基线');
        },
      });
      editorView.mount({
        userSql: editorDraft.set,
        userSqlAlt: editorDraft.join,
        busy: appStore.state.busy,
        schema: appStore.state.schemaSummary ?? null,
      });
    } else {
      editorView = createEditorView({
        root: target,
        onSubmit: (sql) => {
          editorDraft.single = sql;
          submitUserSql(sql);
        },
        onChange: (sql) => { editorDraft.single = sql; },
        onReset: () => {
          if (sandbox) sandbox.resetToBaseline();
          pushInfo('数据库已重置到基线');
        },
      });
      editorView.mount({
        sql: editorDraft.single,
        busy: appStore.state.busy,
        schema: appStore.state.schemaSummary ?? null,
      });
    }
  }

  /** Mount the result/verdict pane. */
  let resultView = null;
  function mountResultPane(target) {
    resultView = createResultView({
      root: target,
      dialogRoot: dialogContainer,
      onAskAi: () => {
        // Drop focus into the tutor composer so the user can immediately
        // ask about the just-shown result. The composer lives in the
        // tutor pane on the same view (data-field is set by tutor-view).
        const ta = /** @type {HTMLTextAreaElement | null} */ (
          document.querySelector('[data-field="tutor-input"]')
        );
        if (ta && typeof ta.focus === 'function') {
          ta.focus();
          // Scroll the tutor pane into view on small screens where the
          // mobile breakpoint stacks the columns vertically.
          ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      },
    });
    resultView.mount({
      result: appStore.state.userResult ?? null,
      verdict: appStore.state.verdict ?? null,
      expectedResult: appStore.state.question?.expectedResult ?? null,
    });
  }

  /** Push an informational toast — surfaces as a quiet success message. */
  function pushInfo(message) {
    // Re-use the error pipeline with a benign kind so we don't add another
    // surface; UI_ERROR_PRIORITY treats unknown kinds as nothing-to-show.
    // For now log to console and skip toasting — keeping the UI pristine.
    console.log('[sqlense]', message);
  }

  /** Mount Tutor view into the practice page's right column. */
  let tutorView = null;
  function mountTutorPane(target) {
    // Always rebuild on rerender — the practice view re-renders DOM each time.
    tutorView = createTutorView({
      root: target,
      onNewConversation: () => {
        appStore.set({ tutorThread: [] });
        if (agentState) {
          agentState = mergePartial(/** @type {any} */ (agentState), { tutorThread: [] });
        }
      },
      onSend: async (msg) => {
        if (!ensureRuntime()) return;

        // R13 — only allow tutor turns when there's a question on screen.
        if (!appStore.state.question) {
          appStore.set({
            tutorThread: [
              ...(appStore.state.tutorThread ?? []),
              { role: 'user', content: msg, at: Date.now() },
              { role: 'assistant', content: '请先在主区生成题目，然后我们再一起讨论。', at: Date.now() },
            ],
          });
          return;
        }

        // The followup node appends BOTH the user message and the
        // assistant reply, so we do NOT pre-append the user message here.
        // We only flip `awaitingTutor` on so the spinner shows. Doing
        // both produced the "single send → 2 duplicate user bubbles" bug.
        const priorThread = appStore.state.tutorThread ?? [];
        appStore.set({ awaitingTutor: true });

        // Optimistic UX: render the user message immediately while the
        // model thinks. We do this via a local-only pre-render — the
        // canonical state arrives from `next.tutorThread` and overwrites
        // this in one shot.
        const optimistic = [
          ...priorThread,
          { role: 'user', content: msg, at: Date.now() },
        ];
        // Push the optimistic thread to the view ONLY (not the store)
        // so the followup node still receives the prior thread without
        // the new user message.
        if (tutorView && typeof tutorView.update === 'function') {
          tutorView.update({ thread: optimistic, awaitingReply: true });
        }

        agentState = mergePartial(/** @type {any} */ (agentState), {
          tutorThread: priorThread,
          question: appStore.state.question,
          userSql: agentState?.userSql ?? '',
          schemaSummary: appStore.state.schemaSummary ?? agentState?.schemaSummary ?? null,
          verdict: appStore.state.verdict ?? agentState?.verdict ?? null,
        });

        const next = await graph.runNode('tutor.followup', /** @type {any} */ (agentState), msg);
        agentState = next;
        if (next.failedAgent) {
          // On failure, materialise the optimistic user msg + the error
          // notice so the UI doesn't lose the typed message.
          appStore.set({
            tutorThread: [
              ...optimistic,
              { role: 'assistant', content: `（Tutor 错误：${next.error}）`, at: Date.now() },
            ],
            awaitingTutor: false,
          });
        } else {
          appStore.set({ tutorThread: next.tutorThread ?? [], awaitingTutor: false });
        }
      },
    });
    tutorView.mount({
      thread: appStore.state.tutorThread ?? [],
      awaitingReply: appStore.state.awaitingTutor,
      verdictState: appStore.state.verdict
        ? (appStore.state.verdict.correct ? 'correct' : 'wrong')
        : 'none',
    });
  }

  function renderNav() {
    clear(navContainer);
    const items = /** @type {RouteName[]} */ (['practice', 'database', 'history', 'settings', 'report']);
    for (const r of items) {
      navContainer.appendChild(
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-nav ' + (appStore.state.route === r ? 'btn-active' : ''),
            'data-nav': r,
            onClick: () => navigate(r),
          },
          ZH.nav[r],
        ),
      );
    }
    // Update model name in header
    const modelLabel = appRoot.querySelector('header > div[data-model-label]');
    if (modelLabel) modelLabel.textContent = appStore.state.llm?.modelName ?? 'no model';
  }

  // Initial render.
  views[appStore.state.route] = buildView(appStore.state.route);
  renderNav();
  mountCurrent();
  renderQuotaDialog(dialogContainer, { lastOutcome: appStore.state.lastStoreOutcome, store });
  renderErrorToast(toastContainer, { errors: appStore.state.errors, onDismiss: clearErrors });

  // Subscribe — keep the chrome (nav, dialogs, toasts) in sync. The route
  // body is updated by the view itself via its own `update`/re-render.
  const unsub = appStore.subscribe(() => {
    renderNav();
    const view = views[appStore.state.route];
    if (view && typeof view.update === 'function') {
      switch (appStore.state.route) {
        case 'practice':
          view.update({
            activeDbId: appStore.state.activeDbId,
            activeDbName: activeDbNameFromStore(),
            question: appStore.state.question,
          });
          // Re-mount editor + result + tutor into the freshly-rendered DOM.
          mountPracticePanes();
          break;
        case 'database':
          view.update({
            library: appStore.state.schemaLibrary,
            activeDbId: appStore.state.activeDbId,
            focusedDbId: appStore.state.focusedDbId,
          });
          break;
        case 'history':  view.update({ records: appStore.state.history }); break;
        case 'report':   view.update({ report: appStore.state.report ?? null, history: appStore.state.history ?? [] }); break;
        case 'settings': view.update({ cfg: appStore.state.llm }); break;
      }
    }
    renderQuotaDialog(dialogContainer, { lastOutcome: appStore.state.lastStoreOutcome, store });
    renderErrorToast(toastContainer, { errors: appStore.state.errors, onDismiss: clearErrors });
  });

  return {
    appStore,
    navigate,
    dispose() {
      unsub();
      if (sandbox) sandbox.close();
    },
  };
}

// Auto-boot when imported as the top-level <script>.
if (typeof document !== 'undefined') {
  const root = document.getElementById('app');
  if (root) {
    boot(root).catch((e) => {
      console.error('[sqlense] boot failed:', e);
      // Surface the failure so users don't see a blank page.
      clear(root);
      const banner = document.createElement('div');
      banner.style.cssText = 'padding:16px;background:#fee;color:#900;border:1px solid #f99;margin:16px;border-radius:8px;font-family:system-ui,sans-serif;';
      const title = document.createElement('h2');
      title.style.marginTop = '0';
      title.textContent = 'SQL 智学加载失败';
      const hint = document.createElement('p');
      hint.textContent = '请打开浏览器控制台（F12）查看详细错误。';
      const detail = document.createElement('pre');
      detail.style.cssText = 'white-space:pre-wrap;background:#fff;padding:8px;border-radius:4px;overflow:auto';
      detail.textContent = String(e?.stack || e?.message || e);
      banner.append(title, hint, detail);
      root.appendChild(banner);
    });
  }
}
