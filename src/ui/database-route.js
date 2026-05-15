// Database tab route view — full-page two-column layout.
//
// Left column   — saved-databases list, generate-new form, import-file form
// Right column  — detail view of the active or focused database
//                  (table list, columns, FKs, full DDL preview)
//
// The Practice tab no longer carries any database-management UI; it just
// reads the active database via the app store.
//
// Wiring contract — main.js passes:
//   library, activeDbId, focusedDbId, theme, themeDescription, onGenerate,
//   onImport, onSelect, onDelete, onFocus, onThemeChange,
//   onThemeDescChange.

import { el, clear } from './dom.js';
import { ZH } from '../i18n/zh.js';
import { renderSqlAsNodes } from './sql-highlight.js';

const THEME_KEYS = /** @type {const} */ (['ecommerce', 'campus', 'library', 'hospital', 'custom']);

/**
 * @param {{
 *   root: HTMLElement,
 *   onGenerate: (theme: typeof THEME_KEYS[number], desc?: string) => void,
 *   onImport:   (file: File) => void,
 *   onSelect:   (id: string) => void,
 *   onDelete:   (id: string) => void,
 *   onFocus?:   (id: string | null) => void,
 *   onThemeChange?: (theme: typeof THEME_KEYS[number]) => void,
 *   onThemeDescChange?: (desc: string) => void,
 * }} deps
 */
export function createDatabaseRouteView(deps) {
  const {
    root,
    onGenerate, onImport, onSelect, onDelete,
    onFocus,
    onThemeChange, onThemeDescChange,
  } = deps;

  let local = {
    /** @type {Array<{id:string, name:string, ddl:string, seedSql:string, tables:any[], createdAt?:number, source?:string}>} */
    library: [],
    /** Active (currently loaded into the sandbox) database id. */
    /** @type {string | null} */ activeId: null,
    /** Focused (clicked-to-preview-on-the-right) database id. Defaults to active. */
    /** @type {string | null} */ focusedId: null,
    /** @type {typeof THEME_KEYS[number]} */ theme: 'ecommerce',
    themeDescription: '',
  };

  /** Current focus resolves to: explicit focus → active → first → null. */
  function effectiveFocusId() {
    if (local.focusedId && local.library.some((d) => d.id === local.focusedId)) return local.focusedId;
    if (local.activeId  && local.library.some((d) => d.id === local.activeId))  return local.activeId;
    return local.library[0]?.id ?? null;
  }

  function setFocus(id) {
    local.focusedId = id;
    onFocus?.(id);
    render();
  }

  function buildLeftColumn() {
    // Saved list
    const list = local.library.length > 0
      ? el('ul', { class: 'db-saved-list', 'data-db-list': '' },
          ...local.library.map((db) => {
            const isActive = db.id === local.activeId;
            const isFocus  = db.id === effectiveFocusId();
            return el('li', {
              class: 'db-saved-item ' +
                (isActive ? 'db-saved-active ' : '') +
                (isFocus  ? 'db-saved-focus '  : ''),
              'data-db-id': db.id,
              onClick: (ev) => {
                if (/** @type {HTMLElement} */ (ev.target).closest('[data-action="delete-db"]')) return;
                if (/** @type {HTMLElement} */ (ev.target).closest('[data-action="activate-db"]')) return;
                setFocus(db.id);
              },
            },
              el('span', { class: 'db-saved-name' },
                isActive ? '✓ ' : '',
                db.name,
              ),
              el('span', { class: 'db-saved-meta' },
                `${db.tables?.length ?? '?'} 表`
                + (db.source === 'imported' ? ' · 导入' : '')
                + (db.createdAt ? ' · ' + formatDate(db.createdAt) : ''),
              ),
              el('span', { class: 'db-saved-actions' },
                !isActive
                  ? el('button', {
                      type: 'button',
                      class: 'db-icon-btn',
                      'data-action': 'activate-db',
                      title: '设为活动数据库',
                      onClick: (ev) => { ev.stopPropagation(); onSelect(db.id); },
                    }, '✓')
                  : null,
                el('button', {
                  type: 'button',
                  class: 'db-icon-btn danger',
                  'data-action': 'delete-db',
                  title: '删除',
                  onClick: (ev) => {
                    ev.stopPropagation();
                    if (confirm(`删除数据库「${db.name}」？此操作不可撤销。`)) onDelete(db.id);
                  },
                }, '✕'),
              ),
            );
          }),
        )
      : el('p', { class: 'meta', style: { padding: '6px 2px' } },
          '没有已保存的数据库。在下面新建或导入一个。',
        );

    // Generate form
    const themeRow = el('div', { class: 'compact-row' },
      ...THEME_KEYS.map((k) =>
        el('label', { class: 'theme-option ' + (local.theme === k ? 'theme-option-selected' : '') },
          el('input', {
            type: 'radio', name: 'db-route-theme', value: k,
            checked: local.theme === k ? true : undefined,
            onChange: () => { local.theme = k; onThemeChange?.(k); render(); },
          }),
          ZH.practice.themePicker.options[k],
        ),
      ),
    );
    const customDesc = local.theme === 'custom'
      ? el('label', { class: 'theme-custom' },
          el('span', {}, ZH.practice.themePicker.customDescription),
          el('textarea', {
            rows: 2,
            value: local.themeDescription,
            onInput: (ev) => {
              local.themeDescription = ev.target.value;
              onThemeDescChange?.(local.themeDescription);
            },
          }),
        )
      : null;

    const generateBtn = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      'data-action': 'generate-db',
      onClick: () => onGenerate(local.theme, local.theme === 'custom' ? local.themeDescription : undefined),
    }, '▶ 生成新数据库');

    // Import row
    const fileInput = el('input', {
      type: 'file',
      'data-action': 'import-db',
      accept: '.sql,text/sql,text/plain',
      onChange: (ev) => {
        const f = /** @type {HTMLInputElement} */ (ev.target).files?.[0];
        if (f) onImport(f);
        /** @type {HTMLInputElement} */ (ev.target).value = '';
      },
    });

    return el('aside', { class: 'db-route-side' },
      el('h3', { class: 'db-route-section-title' }, '已保存的数据库'),
      list,
      el('hr', { class: 'db-section-divider' }),
      el('h3', { class: 'db-route-section-title' }, '生成新数据库'),
      themeRow,
      customDesc,
      el('div', { class: 'db-import-row', style: { marginTop: '8px' } }, generateBtn),
      el('hr', { class: 'db-section-divider' }),
      el('h3', { class: 'db-route-section-title' }, '导入数据库（.sql 文件）'),
      el('div', { class: 'db-import-row' }, fileInput),
      el('p', { class: 'meta', style: { marginTop: '4px' } },
        '文件中应包含 CREATE TABLE 与 INSERT 语句。多条语句用分号分隔。'),
    );
  }

  function buildRightColumn() {
    const fid = effectiveFocusId();
    const focused = local.library.find((d) => d.id === fid) ?? null;

    if (!focused) {
      return el('main', { class: 'db-route-main' },
        el('div', { class: 'db-route-empty' },
          el('p', {}, '尚未选择数据库。'),
          el('p', { class: 'meta' }, '请在左侧生成或导入一个数据库，或点击列表项预览。'),
        ),
      );
    }

    const isActive = focused.id === local.activeId;

    const header = el('div', { class: 'db-route-detail-header' },
      el('div', {},
        el('h2', { class: 'db-route-name' }, focused.name),
        el('p', { class: 'meta' },
          `${focused.tables?.length ?? 0} 张表`
          + (focused.source === 'imported' ? ' · 导入' : ' · 生成')
          + (focused.createdAt ? ' · ' + formatDate(focused.createdAt) : ''),
          isActive ? el('span', { class: 'db-route-active-badge' }, '活动') : null,
        ),
      ),
      el('div', { class: 'db-route-detail-actions' },
        !isActive
          ? el('button', {
              type: 'button',
              class: 'btn btn-primary',
              'data-action': 'activate-from-detail',
              onClick: () => onSelect(focused.id),
            }, '设为活动数据库')
          : null,
      ),
    );

    // Tables grid
    const tableBlocks = (focused.tables ?? []).map((t) =>
      el('article', { class: 'db-route-table' },
        el('header', { class: 'db-route-table-head' },
          el('h4', {}, t.name),
          el('span', { class: 'meta' }, `${t.columns?.length ?? 0} 列`),
        ),
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
          ? el('ul', { class: 'schema-fk' },
              ...t.foreignKeys.map((fk) =>
                el('li', {}, `${fk.columns.join(',')} → ${fk.refTable}(${fk.refColumns.join(',')})`),
              ),
            )
          : null,
      ),
    );

    // Raw DDL accordion
    const ddlBlock = el('details', { class: 'db-route-ddl' },
      el('summary', {}, `查看完整 DDL（${focused.ddl?.length ?? 0} 字符）`),
      el('pre', { class: 'tutor-refsql' },
        el('code', {}, ...renderSqlAsNodes(focused.ddl ?? '')),
      ),
    );

    const seedBlock = focused.seedSql
      ? el('details', { class: 'db-route-ddl' },
          el('summary', {}, `查看种子数据（${focused.seedSql.length} 字符）`),
          el('pre', { class: 'tutor-refsql' },
            el('code', {}, ...renderSqlAsNodes(focused.seedSql)),
          ),
        )
      : null;

    return el('main', { class: 'db-route-main' },
      header,
      el('div', { class: 'db-route-tables' }, ...tableBlocks),
      ddlBlock,
      seedBlock,
    );
  }

  function render() {
    clear(root);
    root.appendChild(
      el('section', { class: 'db-route' },
        buildLeftColumn(),
        buildRightColumn(),
      ),
    );
  }

  return {
    mount(props = {}) {
      Object.assign(local, sanitiseProps(props));
      render();
    },
    update(props = {}) {
      Object.assign(local, sanitiseProps(props));
      render();
    },
    unmount() { clear(root); },
  };
}

function sanitiseProps(p) {
  const out = {};
  if (p.library !== undefined)          out.library = Array.isArray(p.library) ? p.library : [];
  if (p.activeDbId !== undefined)       out.activeId = p.activeDbId;
  if (p.focusedDbId !== undefined)      out.focusedId = p.focusedDbId;
  if (p.theme !== undefined)            out.theme = p.theme;
  if (p.themeDescription !== undefined) out.themeDescription = p.themeDescription;
  return out;
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

export default createDatabaseRouteView;
