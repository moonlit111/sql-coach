import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsView } from '../../src/ui/settings-view.js';
import { PersistKey } from '../../src/persist/schema.js';
import { ZH } from '../../src/i18n/zh.js';

describe('Settings view persistence failures', () => {
  let root;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    root.remove();
  });

  function fillCompleteConfig() {
    root.querySelector('[data-field="apiBaseUrl"]').value = 'https://api.example.com/v1';
    root.querySelector('[data-field="apiBaseUrl"]').dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('[data-field="apiKey"]').value = 'sk-test';
    root.querySelector('[data-field="apiKey"]').dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('[data-field="modelName"]').value = 'model-test';
    root.querySelector('[data-field="modelName"]').dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('shows quota failure feedback and forwards the failed save outcome', () => {
    const outcomes = [];
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === PersistKey.SETTINGS) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      Storage.prototype.setItem.call(globalThis.localStorage, key, value);
    });

    const view = createSettingsView({
      root,
      onSave: (_cfg, outcome) => outcomes.push(outcome),
    });
    view.mount();
    fillCompleteConfig();

    root.querySelector('[data-action="save"]').click();

    expect(root.querySelector('[data-test-status]')).toHaveTextContent(ZH.quota.message);
    expect(outcomes).toEqual([{ ok: false, quotaExceeded: true }]);
  });
});
