// Practice view — theme picker + difficulty/topic picker + schema display.
//
// Validates: R6.1 (5 theme options), R6.6 (custom theme description),
// R6.8 (schema display with tables/columns/PK/FK), R8.1 (4 difficulty
// levels exposed in the picker).
//
// The view does NOT call the orchestrator directly. It collects user input
// and delegates to `onStartQuestion(theme, themeDescription, difficulty, topics)`.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { TOPICS } from '../data/topics.js';
import { DIFFICULTY_LEVELS } from '../types.js';

const THEME_KEYS = /** @type {const} */ (['ecommerce', 'campus', 'library', 'hospital', 'custom']);

/**
 * @param {{
 *   root: HTMLElement,
 *   onStartQuestion?: (
 *     theme: typeof THEME_KEYS[number],
 *     themeDescription: string | undefined,
 *     difficulty: 'L1'|'L2'|'L3'|'L4',
 *     topics: string[],
 *   ) => void,
 *   onLoadSchema?: (theme: typeof THEME_KEYS[number], desc?: string) => void,
 * }} deps
 */
export function createPracticeView({ root, onStartQuestion, onLoadSchema } = {}) {
  let local = {
    /** @type {typeof THEME_KEYS[number]} */ theme: 'ecommerce',
    themeDescription: '',
    /** @type {'L1'|'L2'|'L3'|'L4'} */ difficulty: 'L1',
    /** @type {Set<string>} */ topics: new Set(['single_table_select']),
    /** @type {ReadonlyArray<{ name: string, columns: any[], primaryKey: string[], foreignKeys: any[] }> | null} */
    schemaSummary: null,
  };

  function toggleTopic(id) {
    if (local.topics.has(id)) local.topics.delete(id);
    else local.topics.add(id);
    render();
  }

  function render() {
    clear(root);

    // Theme picker — R6.1
    const themePicker = el('fieldset', { class: 'theme-picker' },
      el('legend', {}, ZH.practice.themePicker.title),
      ...THEME_KEYS.map((k) =>
        el('label', { class: 'theme-option' },
          el('input', {
            type: 'radio',
            name: 'theme',
            value: k,
            'data-theme': k,
            checked: local.theme === k ? true : undefined,
            onChange: () => { local.theme = k; render(); },
          }),
          ' ',
          ZH.practice.themePicker.options[k],
        ),
      ),
      // R6.6 — custom theme description textarea.
      local.theme === 'custom'
        ? el('label', { class: 'theme-custom' },
            el('span', {}, ZH.practice.themePicker.customDescription),
            el('textarea', {
              'data-field': 'themeDescription',
              rows: 3,
              value: local.themeDescription,
              onInput: (ev) => { local.themeDescription = ev.target.value; },
            }),
          )
        : null,
      el(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-action': 'load-schema',
          onClick: () => onLoadSchema?.(
            local.theme,
            local.theme === 'custom' ? local.themeDescription : undefined,
          ),
        },
        '生成数据集',
      ),
    );

    // Difficulty picker — R8.1
    const difficultyPicker = el('fieldset', { class: 'difficulty-picker' },
      el('legend', {}, '难度'),
      ...DIFFICULTY_LEVELS.map((lvl) =>
        el(
          'button',
          {
            type: 'button',
            class: 'btn ' + (local.difficulty === lvl ? 'btn-primary' : ''),
            'data-difficulty': lvl,
            onClick: () => { local.difficulty = lvl; render(); },
          },
          `${lvl} ${ZH.practice.difficulty[lvl]}`,
        ),
      ),
    );

    // Topic chips — multi-select from TOPICS (R8.2 covered upstream).
    const topicChips = el('fieldset', { class: 'topic-chips' },
      el('legend', {}, '知识点（可多选）'),
      ...TOPICS.map((t) =>
        el(
          'label',
          {
            class: 'chip ' + (local.topics.has(t.id) ? 'chip-selected' : ''),
            'data-topic': t.id,
          },
          el('input', {
            type: 'checkbox',
            name: 'topic',
            value: t.id,
            checked: local.topics.has(t.id) ? true : undefined,
            onChange: () => toggleTopic(t.id),
          }),
          ' ',
          t.zh,
        ),
      ),
    );

    // Schema display — R6.8
    const schemaPanel = el(
      'section',
      { class: 'schema-panel', 'data-schema-panel': '' },
      el('h3', {}, '当前数据集'),
      ...renderSchema(local.schemaSummary),
    );

    const startBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        'data-action': 'start-question',
        onClick: () => {
          const topics = [...local.topics];
          if (topics.length === 0) return;
          onStartQuestion?.(
            local.theme,
            local.theme === 'custom' ? local.themeDescription : undefined,
            local.difficulty,
            topics,
          );
        },
      },
      ZH.practice.startQuestion,
    );

    root.appendChild(
      el('section', { class: 'practice-view' },
        themePicker,
        difficultyPicker,
        topicChips,
        schemaPanel,
        startBtn,
      ),
    );
  }

  return {
    mount(props = {}) {
      if (props.schemaSummary) local.schemaSummary = props.schemaSummary;
      if (props.theme) local.theme = props.theme;
      if (props.difficulty) local.difficulty = props.difficulty;
      if (props.topics) local.topics = new Set(props.topics);
      render();
    },
    update(props = {}) {
      if (props.schemaSummary !== undefined) local.schemaSummary = props.schemaSummary;
      if (props.theme !== undefined) local.theme = props.theme;
      if (props.difficulty !== undefined) local.difficulty = props.difficulty;
      if (props.topics !== undefined) local.topics = new Set(props.topics);
      render();
    },
    unmount() { clear(root); },
  };
}

/**
 * Render a TableSchema[] block. Returns an array of children for the panel.
 */
function renderSchema(tables) {
  if (!tables || tables.length === 0) {
    return [el('p', { class: 'schema-empty' }, '尚未生成数据集，请先选择主题并点击"生成数据集"。')];
  }
  return tables.map((t) =>
    el('article', { class: 'schema-table', 'data-table-name': t.name },
      el('h4', {}, t.name),
      el('table', { class: 'schema-cols' },
        el('thead', {},
          el('tr', {},
            el('th', {}, '列名'),
            el('th', {}, '类型'),
            el('th', {}, '可空'),
            el('th', {}, '默认'),
          ),
        ),
        el('tbody', {},
          ...(t.columns ?? []).map((c) =>
            el('tr', {},
              el('td', {}, c.name),
              el('td', {}, c.type),
              el('td', {}, c.nullable ? '是' : '否'),
              el('td', {}, c.default == null ? '' : String(c.default)),
            ),
          ),
        ),
      ),
      (t.primaryKey?.length ?? 0) > 0
        ? el('p', { class: 'schema-pk' }, `主键：${t.primaryKey.join(', ')}`)
        : null,
      (t.foreignKeys?.length ?? 0) > 0
        ? el(
            'ul',
            { class: 'schema-fk' },
            ...t.foreignKeys.map((fk) =>
              el('li', {}, `${fk.columns.join(',')} → ${fk.refTable}(${fk.refColumns.join(',')})`),
            ),
          )
        : null,
    ),
  );
}

export default createPracticeView;
