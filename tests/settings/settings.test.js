// Settings module — unit tests for Tasks 10.2*, 10.3*
// Validates: Requirements R1.1, R1.2, R1.5, R1.7, R2.1, R2.3

import { describe, it, expect, beforeEach } from 'vitest';
import { PersistKey } from '../../src/persist/schema.js';

// Reset the in-memory localStorage before each test by clearing all known keys
// (jsdom provides a real localStorage, so we just `clear()` it).
beforeEach(() => {
  try {
    globalThis.localStorage?.clear();
  } catch { /* ignore */ }
});

// Lazy-import settings so a fresh module-level store probe runs against the
// cleared localStorage. Vitest module cache persists across tests, but the
// store probe runs once per createStore() call inside settings.js, so as long
// as we clear localStorage we're fine — we still reuse the singleton store.
async function loadSettings() {
  return await import('../../src/settings/settings.js');
}

// ---------------------------------------------------------------------------
// Task 10.3* — isComplete
// ---------------------------------------------------------------------------

describe('Settings.isComplete (Task 10.3*) — R1.5', () => {
  it('null → false', async () => {
    const Settings = await loadSettings();
    expect(Settings.isComplete(null)).toBe(false);
  });

  it('undefined → false', async () => {
    const Settings = await loadSettings();
    expect(Settings.isComplete(undefined)).toBe(false);
  });

  it('non-object → false', async () => {
    const Settings = await loadSettings();
    expect(Settings.isComplete('sk-foo')).toBe(false);
    expect(Settings.isComplete(42)).toBe(false);
  });

  it('all-empty fields → false', async () => {
    const Settings = await loadSettings();
    expect(
      Settings.isComplete({ apiBaseUrl: '', apiKey: '', modelName: '' }),
    ).toBe(false);
  });

  it('whitespace-only fields → false', async () => {
    const Settings = await loadSettings();
    expect(
      Settings.isComplete({ apiBaseUrl: '   ', apiKey: '\t', modelName: '\n' }),
    ).toBe(false);
  });

  it('missing one field → false', async () => {
    const Settings = await loadSettings();
    expect(
      Settings.isComplete({ apiBaseUrl: 'http://x', apiKey: '', modelName: 'm' }),
    ).toBe(false);
    expect(
      Settings.isComplete({ apiBaseUrl: 'http://x', apiKey: 'k', modelName: '' }),
    ).toBe(false);
    expect(
      Settings.isComplete({ apiBaseUrl: '', apiKey: 'k', modelName: 'm' }),
    ).toBe(false);
  });

  it('all three present → true', async () => {
    const Settings = await loadSettings();
    expect(
      Settings.isComplete({
        apiBaseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        modelName: 'gpt-4o-mini',
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 10.2* — maskApiKey display state machine (R1.7)
// ---------------------------------------------------------------------------

describe('Settings.maskApiKey (Task 10.2*) — R1.7', () => {
  it('empty input → empty string', async () => {
    const Settings = await loadSettings();
    expect(Settings.maskApiKey('', false)).toBe('');
    expect(Settings.maskApiKey('', true)).toBe('');
  });

  it('revealed=true returns the key verbatim', async () => {
    const Settings = await loadSettings();
    const k = 'sk-test-1234567890';
    expect(Settings.maskApiKey(k, true)).toBe(k);
  });

  it('short keys (≤8 chars) become all bullets when masked', async () => {
    const Settings = await loadSettings();
    expect(Settings.maskApiKey('short', false)).toBe('•••••');
    expect(Settings.maskApiKey('12345678', false)).toBe('••••••••');
  });

  it('long keys keep the first 4 and last 4 visible, middle bulleted', async () => {
    const Settings = await loadSettings();
    const k = 'sk-test-1234567890';
    const masked = Settings.maskApiKey(k, false);
    expect(masked.startsWith('sk-t')).toBe(true);
    expect(masked.endsWith('7890')).toBe(true);
    expect(masked).toMatch(/•+/);
    // The masked output never reveals the full key
    expect(masked).not.toBe(k);
  });

  it('null/undefined input → empty string', async () => {
    const Settings = await loadSettings();
    expect(Settings.maskApiKey(null, false)).toBe('');
    expect(Settings.maskApiKey(undefined, false)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// save / load / clear round-trip (R1.2, R2.1, R2.3)
// ---------------------------------------------------------------------------

describe('Settings.save/load/clear', () => {
  it('round-trips a full LlmConfig', async () => {
    const Settings = await loadSettings();
    const cfg = {
      apiBaseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-deep-1234',
      modelName: 'deepseek-chat',
    };
    Settings.save(cfg);
    expect(Settings.load()).toEqual(cfg);
  });

  it('clear removes the settings entry', async () => {
    const Settings = await loadSettings();
    Settings.save({
      apiBaseUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-local',
      modelName: 'llama3',
    });
    Settings.clear();
    expect(Settings.load()).toBeNull();
  });

  it('clear removes the apiKey from the underlying localStorage string', async () => {
    const Settings = await loadSettings();
    const apiKey = 'sk-secret-canary-9999';
    Settings.save({
      apiBaseUrl: 'http://x.test/v1',
      apiKey,
      modelName: 'm',
    });
    Settings.clear();
    // Walk localStorage — neither the settings key nor any other key
    // should still contain the apiKey substring.
    const ls = globalThis.localStorage;
    let found = false;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      const v = ls.getItem(k);
      if (v && v.includes(apiKey)) { found = true; break; }
    }
    expect(found).toBe(false);
    // Also belt-and-suspenders: PersistKey.SETTINGS gone.
    expect(ls.getItem(PersistKey.SETTINGS)).toBeNull();
  });
});
