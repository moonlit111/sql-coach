// SQL 教练 application boot (Task 16.1).
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

import { createLlmClient } from './llm/client.js';
import { Sandbox } from './sandbox/sandbox.js';
import { createGraph } from './orchestrator/graph.js';
import { createInitialState, mergePartial, resetTutorForNewQuestion } from './orchestrator/state.js';

import { createSettingsView } from './ui/settings-view.js';
import { createPracticeView } from './ui/practice-view.js';
import { createEditorView } from './ui/editor-view.js';
import { createDualEditorView } from './ui/dual-editor-view.js';
import { createResultView } from './ui/result-view.js';
import { createTutorView } from './ui/tutor-view.js';
import { createHistoryView } from './ui/history-view.js';
import { createReportView } from './ui/report-view.js';
import { renderQuotaDialog } from './ui/quota-dialog.js';
import { renderErrorToast } from './ui/error-toast.js';

/**
 * @typedef {('practice'|'history'|'settings'|'report')} RouteName
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
   *           awaitingTutor: boolean, busy: boolean }} */
  const initialState = {
    route: settings.isComplete(cfg) ? 'practice' : 'settings', // R1.5
    llm: cfg ?? null,
    schema: store.get(PersistKey.CURRENT_SCHEMA),               // R15.3
    schemaSummary: null,
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

  function ensureRuntime() {
    if (!settings.isComplete(appStore.state.llm)) return false;
    if (sandbox && llmClient && graph) return true;
    sandbox = new Sandbox({ useWorker: false });
    llmClient = createLlmClient(appStore.state.llm);
    graph = createGraph({ llmClient, sandbox });
    agentState = createInitialState({ llm: appStore.state.llm, theme: 'ecommerce' });
    return true;
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
          onSave: (newCfg) => {
            appStore.set({ llm: newCfg, route: 'practice' });
            sandbox = null; llmClient = null; graph = null; // force rebuild
          },
          onClear: () => { appStore.set({ llm: null, route: 'settings' }); },
        });
      case 'practice':
        return buildPracticeView();
      case 'history':
        return createHistoryView({ root: routeContainer, store });
      case 'report':
        return createReportView({
          root: routeContainer,
          onGenerate: () => generateReport(),
        });
    }
  }

  function buildPracticeView() {
    return createPracticeView({
      root: routeContainer,
      onLoadSchema: async (theme, themeDescription) => {
        if (!ensureRuntime()) return;
        appStore.set({ busy: true });
        agentState = mergePartial(/** @type {any} */ (agentState), {
          theme, themeDescription,
        });
        const next = await graph.runNode('schemaGen', /** @type {any} */ (agentState));
        agentState = next;
        if (next.failedAgent) {
          pushError({ kind: 'bad_response', message: String(next.error) });
        } else {
          appStore.set({ schemaSummary: next.schemaSummary, schema: { ddl: next.ddl, seedSql: next.seedSql, tables: next.schemaSummary } });
          safeSet(PersistKey.CURRENT_SCHEMA, { ddl: next.ddl, seedSql: next.seedSql, tables: next.schemaSummary, createdAt: Date.now() });
        }
        appStore.set({ busy: false });
      },
      onStartQuestion: async (theme, themeDescription, difficulty, topics) => {
        if (!ensureRuntime()) return;
        appStore.set({ busy: true });
        agentState = mergePartial(/** @type {any} */ (agentState), {
          theme, themeDescription,
          requestedDifficulty: difficulty,
          requestedTopics: topics,
        });
        const next = await graph.runNode('questionGen', /** @type {any} */ (agentState));
        agentState = next;
        if (next.failedAgent) {
          pushError({ kind: 'bad_response', message: String(next.error) });
        } else {
          appStore.set({ question: next.question, verdict: null, userResult: null, tutorThread: [] });
          const bank = appStore.state.questions.slice();
          bank.push(next.question);
          safeSet(PersistKey.QUESTION_BANK, bank);
          appStore.set({ questions: bank });
        }
        appStore.set({ busy: false });
      },
    });
  }

  async function generateReport() {
    if (!ensureRuntime()) return;
    appStore.set({ busy: true });
    const next = await graph.runNode('reporter', /** @type {any} */ (agentState ?? createInitialState({ llm: appStore.state.llm, theme: 'ecommerce' })));
    if (next.failedAgent) pushError({ kind: 'bad_response', message: String(next.error) });
    else appStore.set({ report: next.report });
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
          schemaSummary: appStore.state.schemaSummary,
        });
        // Mount the Tutor pane into the right column placeholder.
        const tutorMount = routeContainer.querySelector('[data-tutor-mount]');
        if (tutorMount) {
          mountTutorPane(tutorMount);
        }
        break;
      case 'history':
        view.mount({ records: appStore.state.history });
        break;
      case 'report':
        view.mount({
          markdown: appStore.state.report ?? '',
          historyLength: (appStore.state.history ?? []).length,
        });
        break;
    }
  }

  /** Mount Tutor view into the practice page's right column. */
  let tutorView = null;
  function mountTutorPane(target) {
    // Always rebuild on rerender — the practice view re-renders DOM each time.
    tutorView = createTutorView({
      root: target,
      onSend: async (msg) => {
        const next = [
          ...(appStore.state.tutorThread ?? []),
          { role: 'user', content: msg, at: Date.now() },
        ];
        appStore.set({ tutorThread: next, awaitingTutor: true });

        // MVP placeholder: real Tutor agent invocation is wired post-MVP.
        // Here we produce a contextual reply so the UI is exercised.
        setTimeout(() => {
          const reply = appStore.state.question
            ? '提交答案后我会针对错题给出诊断。请先点击"提交"。'
            : '请先在主区生成题目，然后我们就可以一起讨论。';
          appStore.set({
            tutorThread: [
              ...appStore.state.tutorThread,
              { role: 'assistant', content: reply, at: Date.now() },
            ],
            awaitingTutor: false,
          });
        }, 500);
      },
    });
    tutorView.mount({
      thread: appStore.state.tutorThread ?? [],
      awaitingReply: appStore.state.awaitingTutor,
      refSql: appStore.state.question?.refSql ?? '',
      refRevealed: false,
    });
  }

  function renderNav() {
    clear(navContainer);
    const items = /** @type {RouteName[]} */ (['practice', 'history', 'settings', 'report']);
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
          view.update({ schemaSummary: appStore.state.schemaSummary });
          // Re-mount tutor into the freshly-rendered right column.
          const tutorMount = routeContainer.querySelector('[data-tutor-mount]');
          if (tutorMount) mountTutorPane(tutorMount);
          break;
        case 'history':  view.update({ records: appStore.state.history }); break;
        case 'report':   view.update({ markdown: appStore.state.report ?? '', historyLength: (appStore.state.history ?? []).length }); break;
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
      console.error('[sql-coach] boot failed:', e);
      // Surface the failure so users don't see a blank page.
      root.innerHTML = '';
      const banner = document.createElement('div');
      banner.style.cssText = 'padding:16px;background:#fee;color:#900;border:1px solid #f99;margin:16px;border-radius:8px;font-family:system-ui,sans-serif;';
      banner.innerHTML = `<h2 style="margin-top:0">SQL 教练加载失败</h2>
        <p>请打开浏览器控制台（F12）查看详细错误。</p>
        <pre style="white-space:pre-wrap;background:#fff;padding:8px;border-radius:4px;overflow:auto">${
          String(e?.stack || e?.message || e).replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))
        }</pre>`;
      root.appendChild(banner);
    });
  }
}
