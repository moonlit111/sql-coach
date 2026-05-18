// Test setup: extends Vitest's expect with jest-dom matchers for DOM assertions
// and normalises localStorage. Some Node/Vitest combinations expose a
// partial `globalThis.localStorage` object (hence the `--localstorage-file`
// warning) that lacks the Web Storage methods jsdom tests expect.
import '@testing-library/jest-dom/vitest';

function createMemoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key) {
      const k = String(key);
      return map.has(k) ? map.get(k) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
  };
}

function installStoragePolyfill(target) {
  if (!target) return;
  let current;
  try {
    current = target.localStorage;
  } catch {
    current = null;
  }
  const complete =
    current &&
    typeof current.getItem === 'function' &&
    typeof current.setItem === 'function' &&
    typeof current.removeItem === 'function' &&
    typeof current.clear === 'function' &&
    typeof current.key === 'function' &&
    typeof current.length === 'number';
  if (complete) return;

  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    enumerable: true,
    value: createMemoryStorage(),
  });
}

installStoragePolyfill(globalThis);
if (typeof window !== 'undefined') installStoragePolyfill(window);
