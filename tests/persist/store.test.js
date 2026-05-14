// Unit tests for src/persist/store.js
// Validates: R2.1, R2.5, R15.1, R15.2, R15.6

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStore } from '../../src/persist/store.js';
import { PersistKey } from '../../src/persist/schema.js';

describe('store: small write happy path', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('set returns { ok: true } for a small value', () => {
    const store = createStore();
    const out = store.set(PersistKey.SETTINGS, {
      apiBaseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      modelName: 'gpt-4o-mini',
    });
    expect(out).toEqual({ ok: true });
    expect(store.usingFallback).toBe(false);
  });

  it('get returns null for an absent key', () => {
    const store = createStore();
    expect(store.get('sqlcoach.unset.key')).toBeNull();
  });

  it('exportAll/importAll round-trips persisted keys', () => {
    const store = createStore();
    store.set(PersistKey.SETTINGS, { apiBaseUrl: 'x', apiKey: 'y', modelName: 'z' });
    store.set(PersistKey.SCHEMA_VERSION, 1);

    const json = store.exportAll();

    globalThis.localStorage.clear();
    const fresh = createStore();
    const imported = fresh.importAll(json);
    expect(imported.ok).toBe(true);

    expect(fresh.get(PersistKey.SETTINGS)).toEqual({
      apiBaseUrl: 'x', apiKey: 'y', modelName: 'z',
    });
    expect(fresh.get(PersistKey.SCHEMA_VERSION)).toBe(1);
  });
});

describe('store: localStorage disabled fallback (R2.5)', () => {
  /** @type {PropertyDescriptor | undefined} */
  let originalDescriptor;

  beforeEach(() => {
    // Capture the current localStorage descriptor so we can restore it.
    originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

    // Override the localStorage getter to throw on access — this is what
    // privacy-mode browsers and locked-down WebViews do (R2.5).
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: localStorage is disabled');
      },
    });
  });

  afterEach(() => {
    // Restore whatever was there before (jsdom's normal localStorage).
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    } else {
      // @ts-ignore: in case nothing was originally defined
      delete globalThis.localStorage;
    }
  });

  it('falls back to in-memory adapter and exposes usingFallback=true', () => {
    const store = createStore();
    expect(store.usingFallback).toBe(true);
  });

  it('round-trips set/get in fallback mode', () => {
    const store = createStore();
    const cfg = { apiBaseUrl: 'a', apiKey: 'b', modelName: 'c' };
    const result = store.set(PersistKey.SETTINGS, cfg);
    expect(result.ok).toBe(true);
    expect(store.get(PersistKey.SETTINGS)).toEqual(cfg);

    store.remove(PersistKey.SETTINGS);
    expect(store.get(PersistKey.SETTINGS)).toBeNull();
  });
});
