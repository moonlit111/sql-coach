// Settings view (R1.1, R1.6, R1.7, R2.3, R3.2).
//
// Renders three input fields (apiBaseUrl, apiKey, modelName), a mask
// toggle on the API key (R1.7), a "测试连接" button wired to
// settings.testConnection (R1.6), a "清除配置" button wired to
// settings.clear (R2.3), and a static CORS notice (R3.2).
//
// On save, the view delegates persistence to the settings module and
// pushes the new config into the app store via the `onSave` callback.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import * as settings from '../settings/settings.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   onSave?: (cfg: { apiBaseUrl: string, apiKey: string, modelName: string }) => void,
 *   onClear?: () => void,
 * }} deps
 */
export function createSettingsView({ root, onSave, onClear } = {}) {
  /** @type {{ apiBaseUrl: string, apiKey: string, modelName: string, revealed: boolean, testStatus: string }} */
  let local = {
    apiBaseUrl: '',
    apiKey: '',
    modelName: '',
    revealed: false,
    testStatus: '',
  };

  function render() {
    clear(root);

    const form = el(
      'form',
      {
        class: 'settings-form',
        onSubmit: (ev) => {
          ev.preventDefault();
          handleSave();
        },
      },
      el('h2', {}, ZH.settings.title),

      // CORS notice — R3.2.
      el('p', { class: 'settings-cors-notice', 'data-cors-notice': '' }, ZH.settings.corsNotice),

      el(
        'label',
        { class: 'settings-field' },
        el('span', {}, ZH.settings.apiBaseUrl),
        el('input', {
          type: 'url',
          'data-field': 'apiBaseUrl',
          value: local.apiBaseUrl,
          required: true,
          onInput: (ev) => { local.apiBaseUrl = ev.target.value; },
        }),
      ),

      el(
        'label',
        { class: 'settings-field' },
        el('span', {}, ZH.settings.apiKey),
        el(
          'span',
          { class: 'settings-key-row' },
          el('input', {
            type: local.revealed ? 'text' : 'password',
            'data-field': 'apiKey',
            value: local.apiKey,
            required: true,
            onInput: (ev) => { local.apiKey = ev.target.value; },
          }),
          el(
            'button',
            {
              type: 'button',
              'data-action': 'toggle-reveal',
              class: 'btn btn-ghost',
              onClick: () => { local.revealed = !local.revealed; render(); },
            },
            local.revealed ? ZH.settings.hide : ZH.settings.show,
          ),
        ),
        // Visible mask preview (R1.7) — read-only, never echoes the raw key.
        el(
          'small',
          { class: 'settings-key-mask', 'data-mask-preview': '' },
          settings.maskApiKey(local.apiKey, local.revealed),
        ),
      ),

      el(
        'label',
        { class: 'settings-field' },
        el('span', {}, ZH.settings.modelName),
        el('input', {
          type: 'text',
          'data-field': 'modelName',
          value: local.modelName,
          required: true,
          onInput: (ev) => { local.modelName = ev.target.value; },
        }),
      ),

      el(
        'div',
        { class: 'settings-actions' },
        el(
          'button',
          { type: 'submit', class: 'btn btn-primary', 'data-action': 'save' },
          '保存',
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'btn',
            'data-action': 'test-connection',
            onClick: () => handleTestConnection(),
          },
          ZH.settings.testConnection,
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger',
            'data-action': 'clear-config',
            onClick: () => handleClear(),
          },
          ZH.settings.clearConfig,
        ),
      ),

      local.testStatus
        ? el('p', { class: 'settings-status', 'data-test-status': '' }, local.testStatus)
        : null,
    );

    root.appendChild(form);
  }

  function currentCfg() {
    return {
      apiBaseUrl: local.apiBaseUrl,
      apiKey: local.apiKey,
      modelName: local.modelName,
    };
  }

  function handleSave() {
    const cfg = currentCfg();
    if (!settings.isComplete(cfg)) {
      local.testStatus = '配置不完整：请填写全部三个字段。';
      render();
      return;
    }
    settings.save(cfg);
    local.testStatus = '已保存。';
    onSave?.(cfg);
    render();
  }

  async function handleTestConnection() {
    const cfg = currentCfg();
    local.testStatus = '正在测试连接……';
    render();
    const result = await settings.testConnection(cfg);
    if (result.ok) {
      local.testStatus = `连接正常（${result.latencyMs}ms）`;
    } else {
      local.testStatus = `连接失败：${result.error?.message ?? '未知错误'}`;
    }
    render();
  }

  function handleClear() {
    settings.clear();
    local = { apiBaseUrl: '', apiKey: '', modelName: '', revealed: false, testStatus: '已清除配置。' };
    onClear?.();
    render();
  }

  return {
    mount(props = {}) {
      const cfg = props.cfg ?? settings.load() ?? null;
      if (cfg && typeof cfg === 'object') {
        local = {
          apiBaseUrl: cfg.apiBaseUrl ?? '',
          apiKey: cfg.apiKey ?? '',
          modelName: cfg.modelName ?? '',
          revealed: false,
          testStatus: '',
        };
      }
      render();
    },
    update(props = {}) {
      if (props.cfg) {
        local = {
          apiBaseUrl: props.cfg.apiBaseUrl ?? '',
          apiKey: props.cfg.apiKey ?? '',
          modelName: props.cfg.modelName ?? '',
          revealed: local.revealed,
          testStatus: local.testStatus,
        };
        render();
      }
    },
    unmount() {
      clear(root);
    },
  };
}

export default createSettingsView;
