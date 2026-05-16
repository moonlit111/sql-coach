// Feature: sqlense, Property 3: Credential persistence round-trip and clear
// Validates: Requirements R1.2, R2.1, R2.3, R15.5

import { test, fc } from '@fast-check/vitest';
import { describe, expect, beforeEach } from 'vitest';
import { createStore } from '../../src/persist/store.js';
import { PersistKey } from '../../src/persist/schema.js';

// Generator for arbitrary `LlmConfig` triples per design Property 3.
//  - apiBaseUrl: any well-formed http(s) URL (fc.webUrl)
//  - apiKey:     any non-empty string up to 100 chars
//  - modelName:  identifier-like string, 1..50 chars from [A-Za-z0-9._-]
const llmConfigArb = fc.record({
  apiBaseUrl: fc.webUrl(),
  apiKey: fc.string({ minLength: 1, maxLength: 100 }),
  modelName: fc.stringMatching(/^[a-zA-Z0-9._-]{1,50}$/),
});

describe('Property 3: credential persistence round-trip and clear', () => {
  beforeEach(() => {
    // Each `test.prop` runs many iterations; we also clear inside each
    // property body, but reset between properties as a safety net.
    globalThis.localStorage.clear();
  });

  // R1.2 / R2.1 — settings persist across a fresh store instance reading
  // the same backing localStorage.
  test.prop([llmConfigArb])(
    'save then read from a fresh store returns the same triple',
    (cfg) => {
      globalThis.localStorage.clear();

      const writer = createStore();
      const result = writer.set(PersistKey.SETTINGS, cfg);
      expect(result.ok).toBe(true);

      // A *fresh* store instance must read back identical data — proves
      // the write went through to backing storage, not just memory.
      const reader = createStore();
      const loaded = reader.get(PersistKey.SETTINGS);

      expect(loaded).not.toBeNull();
      expect(loaded.apiBaseUrl).toBe(cfg.apiBaseUrl);
      expect(loaded.apiKey).toBe(cfg.apiKey);
      expect(loaded.modelName).toBe(cfg.modelName);
    }
  );

  // R2.3 / R15.5 — after remove, get returns null AND no raw localStorage
  // entry still contains the apiKey substring.
  test.prop([llmConfigArb])(
    'after remove, get returns null and apiKey is fully scrubbed',
    (cfg) => {
      globalThis.localStorage.clear();

      const s1 = createStore();
      s1.set(PersistKey.SETTINGS, cfg);

      const s2 = createStore();
      s2.remove(PersistKey.SETTINGS);

      expect(s2.get(PersistKey.SETTINGS)).toBeNull();

      // Raw scan: dump every key/value still present and assert apiKey
      // is not a substring of any of them.
      const blobParts = [];
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const k = globalThis.localStorage.key(i);
        blobParts.push(k);
        blobParts.push(globalThis.localStorage.getItem(k) ?? '');
      }
      const blob = blobParts.join('\u0000');
      expect(blob.includes(cfg.apiKey)).toBe(false);
    }
  );
});
