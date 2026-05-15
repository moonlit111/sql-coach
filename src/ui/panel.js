// Reusable Panel component — a framed container with
//   • optional fullscreen toggle (overlay viewport)
//   • optional vertical resize (browser-native CSS resize)
//   • optional hover/click popover showing the body when collapsed
//
// Why this file:
//   - Practice / Question / Editor / Result / Tutor / Schema all want the
//     same chrome (title + controls + body). Repeating the plumbing would
//     be ~30 lines per panel and would drift between panels over time.
//     One Panel component keeps every section consistent.
//   - The panel exposes a stable `bodyContainer` DOM node so callers can
//     mount their content once and not lose state on parent re-renders.
//
// Note on collapse: the inline collapse chevron was removed because the
// practice view's grid layout fixes row heights to CSS variables — when
// the body hides via display:none, the grid track stays at its assigned
// size, so collapse had no visible effect. The `setCollapsed` /
// `isCollapsed` API is kept programmatically for the popoverOnHover
// branch (which still cares about collapsed state) and to avoid breaking
// any future callers; only the UI button is gone.
//
// Usage:
//   const panel = createPanel({ title: '数据库' });
//   parent.appendChild(panel.root);
//   panel.bodyContainer.appendChild(myView);
//   panel.setMeta('4 张表');

import { el } from './dom.js';

/**
 * @typedef {Object} PanelOpts
 * @property {string}   title
 * @property {boolean=} collapsed             Initial collapsed state. Defaults false.
 *                                            Programmatic only — there is no UI toggle.
 * @property {boolean=} fullscreenable        Whether to render the fullscreen button. Defaults true.
 * @property {'none'|'vertical'|'both'=} resize  Native CSS resize on the body host. Defaults 'vertical'.
 * @property {boolean=} popoverOnHover        When collapsed (programmatically), hovering the
 *                                            header pops up the body in a floating panel.
 *                                            Click still expands inline. Defaults false.
 * @property {string=}  popoverWidth          Optional CSS width for the popover (e.g. '420px').
 * @property {string=}  emptyHint             Text shown inside the body when no children exist.
 *                                            (Caller controls actual children; this is fallback only.)
 * @property {Node[]=}  headerExtra           Optional extra DOM nodes inserted into the header's
 *                                            actions area, BEFORE the fullscreen icon.
 *                                            Useful for context-specific buttons like "参考答案".
 * @property {(collapsed: boolean) => void=} onCollapseChange   Fires only when setCollapsed is
 *                                                              called programmatically (no UI toggle).
 * @property {(fullscreen: boolean) => void=} onFullscreenChange
 */

/**
 * Build a Panel and return its imperative handle.
 *
 * @param {PanelOpts} opts
 */
export function createPanel(opts) {
  const {
    title,
    collapsed = false,
    fullscreenable = true,
    resize = 'vertical',
    popoverOnHover = false,
    popoverWidth = '420px',
    headerExtra = [],
    onCollapseChange,
    onFullscreenChange,
  } = opts;

  let isCollapsed   = Boolean(collapsed);
  let isFullscreen  = false;
  /** @type {HTMLElement | null} */ let activePopover = null;
  /** @type {number | null} */     let popoverHideTimer = null;

  // Title + meta + action buttons live in the header.
  const titleEl = el('span', { class: 'pf-title' }, title);
  const metaEl  = el('span', { class: 'pf-meta', 'data-pf-meta': '' });

  const fullscreenBtn = el('button', {
    type: 'button',
    class: 'pf-action pf-action-fullscreen',
    'data-action': 'pf-fullscreen',
    title: '全屏 / 还原',
    onClick: () => setFullscreen(!isFullscreen),
  }, '⛶');

  const actionsEl = el('div', { class: 'pf-actions' },
    fullscreenable ? fullscreenBtn : null,
  );

  // Optional caller-provided buttons (e.g. "参考答案"). They live in their
  // own container so a later setHeaderExtra() can swap them without
  // touching the collapse/fullscreen icons.
  const headerExtraEl = el('div', { class: 'pf-header-extra' });
  for (const node of headerExtra) {
    if (node instanceof Node) headerExtraEl.appendChild(node);
  }

  const headerEl = el('header', { class: 'pf-header' },
    titleEl, metaEl, headerExtraEl, actionsEl,
  );

  // Body host — content lives here. We use `data-pf-body=""` so callers
  // (and the popover) can find it by selector.
  const bodyHost = el('div', { class: 'pf-body', 'data-pf-body': '' });
  if (resize !== 'none') {
    bodyHost.style.resize = resize;
    bodyHost.style.overflow = 'auto';
  }

  const root = el('section',
    {
      class: 'pf' + (isCollapsed ? ' pf-collapsed' : '') +
             (popoverOnHover ? ' pf-pophover' : ''),
      'data-panel': '',
    },
    headerEl,
    bodyHost,
  );

  // ── Hover popover when collapsed ───────────────────────────────────
  /** A function returning fresh DOM content each time the popover opens.
   *  Allows the parent to re-render information (e.g. active DB name)
   *  without rebuilding the panel itself. */
  /** @type {null | (() => Node)} */
  let popoverProvider = null;

  function showPopover() {
    if (!isCollapsed || !popoverOnHover) return;
    if (activePopover) return;
    cancelHide();
    const rect = headerEl.getBoundingClientRect();
    const pop = el('div', {
      class: 'pf-popover',
      'data-pf-popover': '',
      style: {
        position: 'fixed',
        top: `${rect.bottom + 6}px`,
        left: `${rect.left}px`,
        width: popoverWidth,
        zIndex: '1300',
      },
      onMouseEnter: cancelHide,
      onMouseLeave: scheduleHide,
    });
    if (popoverProvider) {
      // Provider mode: ask the caller for fresh DOM each time.
      try {
        const node = popoverProvider();
        if (node) pop.appendChild(node);
      } catch { /* never break the panel */ }
    } else {
      // Fallback: borrow the body's children. Holds them temporarily and
      // restores on hide so the underlying DOM (and any mounted views)
      // survives intact.
      while (bodyHost.firstChild) pop.appendChild(bodyHost.firstChild);
    }
    document.body.appendChild(pop);
    activePopover = pop;
  }
  function hidePopover() {
    if (!activePopover) return;
    if (popoverProvider) {
      // Provider mode: just discard the popover; body was untouched.
      activePopover.remove();
    } else {
      while (activePopover.firstChild) bodyHost.appendChild(activePopover.firstChild);
      activePopover.remove();
    }
    activePopover = null;
  }
  function scheduleHide() {
    cancelHide();
    popoverHideTimer = window.setTimeout(() => {
      hidePopover();
      popoverHideTimer = null;
    }, 200);
  }
  function cancelHide() {
    if (popoverHideTimer !== null) {
      clearTimeout(popoverHideTimer);
      popoverHideTimer = null;
    }
  }
  if (popoverOnHover) {
    headerEl.addEventListener('mouseenter', showPopover);
    headerEl.addEventListener('mouseleave', scheduleHide);
  }

  // ── State setters ──────────────────────────────────────────────────
  function setCollapsed(next, opts2 = { silent: false }) {
    if (next === isCollapsed) return;
    // Closing the popover before toggling avoids a flash where the body
    // is in two places at once.
    if (activePopover) hidePopover();
    isCollapsed = Boolean(next);
    root.classList.toggle('pf-collapsed', isCollapsed);
    if (!opts2.silent) onCollapseChange?.(isCollapsed);
  }

  function setFullscreen(next, opts2 = { silent: false }) {
    if (next === isFullscreen) return;
    if (activePopover) hidePopover();
    isFullscreen = Boolean(next);
    root.classList.toggle('pf-fullscreen', isFullscreen);
    document.body.classList.toggle('pf-has-fullscreen', isFullscreen);
    fullscreenBtn.textContent = isFullscreen ? '⤡' : '⛶';
    // Force-expand when going fullscreen — fullscreen + collapsed makes
    // no sense and would render an empty viewport.
    if (isFullscreen && isCollapsed) setCollapsed(false);
    if (!opts2.silent) onFullscreenChange?.(isFullscreen);
  }

  // Escape exits fullscreen. We add the listener globally; multiple
  // panels share it but only the fullscreen one will actually toggle off.
  function onKeyDown(ev) {
    if (ev.key === 'Escape' && isFullscreen) {
      setFullscreen(false);
    }
  }
  document.addEventListener('keydown', onKeyDown);

  return {
    root,
    bodyContainer: bodyHost,
    setMeta(text) {
      metaEl.textContent = text == null ? '' : String(text);
    },
    setTitle(text) {
      titleEl.textContent = text == null ? '' : String(text);
    },
    /** Provide a function that returns the popover content. When set,
     *  the popover does not borrow the panel's body — instead it asks
     *  the provider for fresh DOM each time it opens. */
    setPopoverProvider(fn) { popoverProvider = typeof fn === 'function' ? fn : null; },
    /** Replace the header's extra-action slot. Pass an array of DOM nodes. */
    setHeaderExtra(nodes) {
      while (headerExtraEl.firstChild) headerExtraEl.removeChild(headerExtraEl.firstChild);
      for (const n of nodes ?? []) {
        if (n instanceof Node) headerExtraEl.appendChild(n);
      }
    },
    setCollapsed,
    setFullscreen,
    isCollapsed: () => isCollapsed,
    isFullscreen: () => isFullscreen,
    /** Tear down listeners. Useful when the parent unmounts. */
    dispose() {
      document.removeEventListener('keydown', onKeyDown);
      hidePopover();
    },
  };
}

export default createPanel;
