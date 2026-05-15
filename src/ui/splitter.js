// Splitter — a thin draggable bar that resizes the columns it sits between.
//
// Why this file:
//   - CSS Grid has no native column-resize mechanism. We expose two CSS
//     custom properties (`--col-side`, `--col-tutor`) on the practice
//     container; the splitter drags them.
//   - Pointer Events + setPointerCapture replace mousemove/up listeners,
//     so we don't have to attach to window and clean up across iframes.
//   - The splitter is purely visual (a 4px-wide vertical bar). It emits
//     onResize(deltaPx) on every move; the practice view applies the
//     value with min/max clamps and persists to localStorage so column
//     widths survive a reload.
//
// Usage:
//   const sp = createSplitter({
//     orientation: 'vertical',  // a vertical bar, drags horizontally
//     onResize: (delta) => { ... },
//   });
//   parent.appendChild(sp.root);

import { el } from './dom.js';

/**
 * @typedef {Object} SplitterOpts
 * @property {'vertical'|'horizontal'=} orientation  Default 'vertical'.
 * @property {(deltaPx: number) => void} onResize   Called on each pointermove
 *                                                  with the delta since the last call.
 * @property {() => void=} onResizeStart            Optional — fired on pointerdown.
 * @property {() => void=} onResizeEnd              Optional — fired on pointerup/cancel.
 */

/**
 * @param {SplitterOpts} opts
 */
export function createSplitter(opts) {
  const orientation = opts.orientation ?? 'vertical';
  const isVertical = orientation === 'vertical';

  let dragging = false;
  let lastCoord = 0;

  /** Restore body styles to whatever they were before drag start. We
   *  cache the originals so the splitter doesn't clobber a userSelect
   *  rule the page might rely on (e.g. inside a modal). */
  let prevUserSelect = '';
  let prevCursor = '';

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('splitter-dragging');
    document.body.style.userSelect = prevUserSelect;
    document.body.style.cursor = prevCursor;
  }

  const root = el('div', {
    class: 'splitter splitter-' + (isVertical ? 'v' : 'h'),
    'data-splitter': '',
    role: 'separator',
    'aria-orientation': isVertical ? 'vertical' : 'horizontal',
    tabindex: '0',
    onPointerDown: (ev) => {
      dragging = true;
      lastCoord = isVertical ? ev.clientX : ev.clientY;
      try { root.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      root.classList.add('splitter-dragging');
      prevUserSelect = document.body.style.userSelect;
      prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = isVertical ? 'col-resize' : 'row-resize';
      opts.onResizeStart?.();
      ev.preventDefault();
    },
    onPointerMove: (ev) => {
      if (!dragging) return;
      const next = isVertical ? ev.clientX : ev.clientY;
      const delta = next - lastCoord;
      if (delta !== 0) {
        lastCoord = next;
        opts.onResize?.(delta);
      }
    },
    onPointerUp: (ev) => {
      if (!dragging) return;
      try { root.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      endDrag();
      opts.onResizeEnd?.();
    },
    onPointerCancel: () => {
      if (!dragging) return;
      endDrag();
      opts.onResizeEnd?.();
    },
    onKeyDown: (ev) => {
      // Keyboard accessibility — arrow keys nudge by 8px.
      const STEP = 8;
      if (isVertical && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        ev.preventDefault();
        opts.onResize?.(ev.key === 'ArrowLeft' ? -STEP : STEP);
      } else if (!isVertical && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        ev.preventDefault();
        opts.onResize?.(ev.key === 'ArrowUp' ? -STEP : STEP);
      }
    },
  });

  return {
    root,
    /**
     * Cancel any in-flight drag and restore body styles. Safe to call
     * multiple times. The practice view should call this when unmounting
     * so a stuck drag (root removed mid-drag) doesn't leave the page
     * with `user-select: none` and a `col-resize` cursor.
     */
    dispose() { endDrag(); },
  };
}

export default createSplitter;
