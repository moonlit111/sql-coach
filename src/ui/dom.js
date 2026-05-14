// Tiny DOM helper — `el(tag, props, ...children)` plus `clear(node)`.
//
// Replaces the framework that we deliberately don't have (R4.1 — no build
// step). Every UI view in src/ui/* imports `el` and renders into a passed-in
// `root` DOM node.

/**
 * Create a DOM element with attributes/event handlers/children.
 *
 * - `class` becomes `className`.
 * - `style` is shallow-merged into element.style.
 * - `on*` properties (e.g. `onClick`, `onInput`) attach event listeners; the
 *   event name is the lowercased remainder of the prop name.
 * - `dataset` is shallow-merged into element.dataset.
 * - boolean `true` becomes a present attribute with empty string; `false`,
 *   `null`, `undefined` skip the attribute entirely.
 *
 * Children are flattened; strings/numbers become text nodes; falsy values
 * (null/undefined/false) are skipped.
 *
 * @param {string} tag
 * @param {Record<string, any> | null | undefined} [props]
 * @param  {...any} children
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === 'class') {
      node.className = v == null ? '' : String(v);
    } else if (k === 'style' && v && typeof v === 'object') {
      Object.assign(node.style, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'dataset' && v && typeof v === 'object') {
      Object.assign(node.dataset, v);
    } else if (v !== undefined && v !== null && v !== false) {
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') {
      node.appendChild(document.createTextNode(String(c)));
    } else if (c instanceof Node) {
      node.appendChild(c);
    } else {
      node.appendChild(document.createTextNode(String(c)));
    }
  }
  return node;
}

/**
 * Remove all children from a node. Used by views' `mount`/`update` to clear
 * stale content before re-rendering.
 *
 * @param {Node} node
 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export default el;
