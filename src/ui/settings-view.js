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

      // Quick presets — speed up first-time setup
      el(
        'div',
        {
          class: 'settings-presets',
          style: {
            marginBottom: 'var(--gap-md)',
            padding: '12px 14px',
            background: 'var(--bg-input)',
            border: '1px solid var(--br)',
            borderRadius: 'var(--r)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--tx-2)',
          },
        },
        el('div', {
          style: {
            fontSize: 'var(--fs-xs)',
            color: 'var(--tx-3)',
            marginBottom: '6px',
            textTransform: 'lowercase',
            letterSpacing: '0.04em',
          },
        }, '▸ 常用预设（点击填入）'),
        ...[
          { label: 'DeepSeek (推荐)', url: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
          { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
          { label: 'Ollama 本地', url: 'http://localhost:11434/v1', model: 'llama3' },
        ].map((p) =>
          el('button', {
            type: 'button',
            class: 'btn',
            style: { marginRight: '6px', marginTop: '4px' },
            onClick: () => {
              local.apiBaseUrl = p.url;
              local.modelName = p.model;
              render();
            },
          }, p.label),
        ),
      ),

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
          placeholder: 'https://api.deepseek.com',
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
            placeholder: 'sk-...',
            onInput: (ev) => { local.apiKey = ev.target.value; },
          }),
          el(
            'button',
            {
              type: 'button',
              'data-action': 'toggle-reveal',
              class: 'btn',
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
          placeholder: 'deepseek-v4-flash',
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
