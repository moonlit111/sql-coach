// Database Manager view body — replaces the old "主题" picker.
//
// Responsibilities:
//   - Show the list of saved databases (generated + imported).
//   - Allow the user to switch the active database with one click.
//   - Allow the user to import an .sql file (DDL + seed combined or seed
//     only — simple heuristic: split on the first INSERT).
//   - Allow the user to delete a saved database.
//   - Provide the legacy theme + custom-description form for generating a
//     new database via SchemaGen.
//
// The view is driven by an explicit `state` object passed by the parent;
// it never reads localStorage directly. Persistence is the parent's job.
//
// Usage:
//   const view = createDatabasePanelBody({
//     state, onGenerate, onImport, onSelect, onDelete,
//   });
//   panel.bodyContainer.appendChild(view);

import { el } from './dom.js';
import { ZH } from '../i18n/zh.js';

const THEME_KEYS = /** @type {const} */ (['ecommerce', 'campus', 'library', 'hospital', 'custom']);

/**
 * Build the database-panel body.
 *
 * @param {{
 *   library: Array<{ id: string, name: string, tables?: any[], createdAt?: number, source?: 'generated'|'imported' }>,
 *   activeId: string | null,
 *   theme: typeof THEME_KEYS[number],
 *   themeDescription: string,
 *   onGenerate: (theme: typeof THEME_KEYS[number], desc?: string) => void,
 *   onImport: (file: File) => void,
 *   onSelect: (id: string) => void,
 *   onDelete: (id: string) => void,
 *   onThemeChange: (theme: typeof THEME_KEYS[number]) => void,
 *   onThemeDescChange: (desc: string) => void,
 * }} props
 * @returns {HTMLElement}
 */
export function createDatabasePanelBody(props) {
  const {
    library, activeId,
    theme, themeDescription,
    onGenerate, onImport, onSelect, onDelete,
    onThemeChange, onThemeDescChange,
  } = props;

  // ── Saved databases list ─────────────────────────────────────────
  const listSection = library.length > 0
    ? el('ul', { class: 'db-saved-list' },
        ...library.map((db) =>
          el('li', {
            class: 'db-saved-item ' + (db.id === activeId ? 'db-saved-active' : ''),
            'data-db-id': db.id,
            title: '点击切换为活动数据库',
            onClick: (ev) => {
              // Don't trigger selection when clicking the delete icon.
              const target = /** @type {HTMLElement} */ (ev.target);
              if (target.closest('[data-action="delete-db"]')) return;
              onSelect(db.id);
            },
          },
            el('span', {}, db.name),
            el('span', { class: 'db-saved-meta' },
              `${db.tables?.length ?? '?'} 表`
              + (db.source === 'imported' ? ' · 导入' : '')
              + (db.createdAt ? ' · ' + formatDate(db.createdAt) : ''),
            ),
            el('span', { class: 'db-saved-actions' },
              el('button', {
                type: 'button',
                class: 'db-icon-btn danger',
                'data-action': 'delete-db',
                title: '删除',
                onClick: (ev) => {
                  ev.stopPropagation();
                  if (confirm(`删除数据库「${db.name}」？此操作不可撤销。`)) {
                    onDelete(db.id);
                  }
                },
              }, '✕'),
            ),
          ),
        ),
      )
    : el('p', { class: 'meta', style: { padding: '6px 2px' } },
        '没有已保存的数据库。在下面新建或导入一个。',
      );

  // ── Generate-new-database form ────────────────────────────────────
  const themeRow = el('div', { class: 'compact-row' },
    ...THEME_KEYS.map((k) =>
      el('label', { class: 'theme-option ' + (theme === k ? 'theme-option-selected' : '') },
        el('input', {
          type: 'radio', name: 'db-theme', value: k,
          'data-theme': k,
          checked: theme === k ? true : undefined,
          onChange: () => onThemeChange(k),
        }),
        ZH.practice.themePicker.options[k],
      ),
    ),
  );

  const customDesc = theme === 'custom'
    ? el('label', { class: 'theme-custom' },
        el('span', {}, ZH.practice.themePicker.customDescription),
        el('textarea', {
          'data-field': 'themeDescription',
          rows: 2,
          value: themeDescription,
          onInput: (ev) => onThemeDescChange(ev.target.value),
        }),
      )
    : null;

  const generateBtn = el('button', {
    type: 'button',
    class: 'btn btn-primary',
    'data-action': 'load-schema',
    onClick: () => onGenerate(theme, theme === 'custom' ? themeDescription : undefined),
  }, '▶ 生成新数据集');

  // ── Import row ────────────────────────────────────────────────────
  const fileInput = /** @type {HTMLInputElement} */ (el('input', {
    type: 'file',
    'data-action': 'import-db',
    accept: '.sql,text/sql,text/plain',
    onChange: (ev) => {
      const f = ev.target.files?.[0];
      if (f) onImport(f);
      // Reset so the same file can be re-selected.
      ev.target.value = '';
    },
  }));

  return el('div', {},
    el('p', { class: 'db-section-title' }, '已保存的数据库'),
    listSection,
    el('hr', { class: 'db-section-divider' }),
    el('p', { class: 'db-section-title' }, '生成新数据库'),
    themeRow,
    customDesc,
    el('div', { class: 'db-import-row', style: { marginTop: '8px' } },
      generateBtn,
    ),
    el('hr', { class: 'db-section-divider' }),
    el('p', { class: 'db-section-title' }, '导入数据库（.sql 文件）'),
    el('div', { class: 'db-import-row' }, fileInput),
    el('p', { class: 'meta', style: { marginTop: '4px' } },
      '文件中应包含 CREATE TABLE 与 INSERT 语句。多条语句用分号分隔。',
    ),
  );
}

/**
 * Build a hover popover body summarising the active database. This is
 * shown when the user hovers the collapsed Database panel header.
 *
 * @param {{ name: string, tables?: any[] }} db
 * @returns {HTMLElement}
 */
export function createDatabaseInfoPopover(db) {
  if (!db) {
    return el('div', { class: 'db-info-popover' },
      el('p', { class: 'meta' }, '未选择活动数据库。'),
    );
  }
  const tables = db.tables ?? [];
  return el('div', { class: 'db-info-popover' },
    el('h5', {}, db.name),
    el('p', { class: 'meta' }, `${tables.length} 张表`),
    tables.length > 0
      ? el('div', { class: 'db-info-tables' },
          ...tables.flatMap((t) => [
            el('span', {}, t.name),
            el('span', {}, `${t.columns?.length ?? 0} 列`),
          ]),
        )
      : null,
  );
}

function formatDate(ts) {
  try {
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mn = String(d.getMinutes()).padStart(2, '0');
    return `${m}/${day} ${h}:${mn}`;
  } catch { return ''; }
}

export default createDatabasePanelBody;
