// Tiny pub/sub store used by the UI layer.
//
// One global app store coordinates view state without pulling in a framework.
// Subscribers fire on every `set`. The state object itself is replaced (not
// mutated) so consumers can do reference checks if they want.
//
// Validates: R17.3 (immutable updates — every set produces a NEW object),
// integrates with src/main.js (Task 16.1).

/**
 * @template T
 * @param {T} initial
 * @returns {{
 *   readonly state: T,
 *   set: (next: T | Partial<T> | ((s: T) => T)) => void,
 *   subscribe: (fn: (s: T) => void) => () => boolean,
 * }}
 */
export function createAppStore(initial) {
  let state = initial;
  /** @type {Set<(s: T) => void>} */
  const subs = new Set();

  return {
    get state() {
      return state;
    },
    /**
     * Replace state with either a function that derives the next value, an
     * object that is shallow-merged into the current value, or any other
     * value that fully replaces the state.
     */
    set(next) {
      if (typeof next === 'function') {
        state = /** @type {(s: T) => T} */ (next)(state);
      } else if (next !== null && typeof next === 'object' && typeof state === 'object' && state !== null) {
        state = /** @type {T} */ ({ ...state, ...next });
      } else {
        state = /** @type {T} */ (next);
      }
      for (const fn of subs) {
        try { fn(state); } catch { /* swallow subscriber errors */ }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export default createAppStore;
