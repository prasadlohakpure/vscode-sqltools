// Runs inside the webview (browser context), bundled separately from the
// extension-host code — same pattern as chart/webview-entry.ts. Builds a
// Tabulator grid from window.__RESULT_DATA__ and wires the per-column header
// menu + toolbar that cover the requested grid feature list.
// tabulator-tables ships no .d.ts (no @types package either) — everything
// coming out of it is implicitly `any`; these two aliases just name that for
// readability below, they add no real typing.
import { TabulatorFull as Tabulator } from 'tabulator-tables';
type ColumnComponent = any;
type ColumnDefinition = any;

declare global {
  interface Window {
    __RESULT_DATA__: {
      cols: string[];
      rows: Record<string, any>[];
    };
  }
}

const { cols, rows } = window.__RESULT_DATA__;

// per-column toggle state, keyed by field name. Tabulator doesn't track
// these as booleans anywhere queryable, so we own them here and re-derive
// the column's cssClass/formatter from them on every change.
const wrapped = new Set<string>();
const selected = new Set<string>();

function cssClassFor(field: string): string {
  return [wrapped.has(field) && 'col-wrap', selected.has(field) && 'col-selected'].filter(Boolean).join(' ');
}

// Bug fix (the real one — the previous `sorterParams` fix here was correct
// but inert): Tabulator does NOT auto-detect a sorter type from the data.
// Checked in tabulator-tables' own source (`initializeColumn`): when a
// column definition has no explicit `sorter`, the internal sort function is
// set to the literal value `false` — not a fallback comparator. Sorting
// then calls `column.modules.sort.sorter.call(...)` unconditionally
// (`_sortRow`), which throws `TypeError: false.call is not a function` the
// instant any column is sorted — silently, since it's inside `Array.sort`'s
// comparator. This was broken for every column, not just ones with nulls.
// Scans past leading nulls/empties (not just the first row) so a sparse
// leading value doesn't misclassify the column.
function detectSorter(field: string): 'number' | 'string' {
  for (const row of rows) {
    const v = row[field];
    if (v !== null && v !== undefined && v !== '') {
      return typeof v === 'number' ? 'number' : 'string';
    }
  }
  return 'string';
}

// Three canned formatters, per the spec ("don't invent a format string DSL").
// "plaintext" and "money" are Tabulator's own built-in formatters. Tabulator's
// own built-in "datetime" formatter requires luxon.js as a peer dependency
// (checked in tabulator-tables' source: it hard-errors without
// `dependencyRegistry.lookup(["luxon","DateTime"])`) — luxon isn't in this
// package's pre-wired dependencies and package.json is out of scope for this
// bolt, so "Date" below is a small custom formatter using the native `Date`
// object instead. That's a real Tabulator capability (formatter accepts any
// function), just not its built-in luxon-backed one.
// ponytail: no per-format options (custom date pattern, currency symbol) —
// three fixed formats is what was asked for; add a params UI if a specific
// format is ever requested.
const FORMATTERS: Record<string, { formatter: any; formatterParams?: any }> = {
  plaintext: { formatter: 'plaintext' },
  money: { formatter: 'money', formatterParams: { thousand: ',', precision: false, symbol: '' } },
  date: {
    formatter: (cell: any) => {
      const v = cell.getValue();
      if (v === null || v === undefined || v === '') return v;
      const d = new Date(v);
      return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
    },
  },
};

// Built as a function, not a static array, so "Reset Columns" can call it
// again for a fresh set of definitions — a plain deep-clone (e.g.
// JSON.parse(JSON.stringify(...))) would silently drop headerMenu, since
// functions don't survive a JSON round-trip.
function buildColumnDefs(): ColumnDefinition[] {
  return cols.map(field => ({
    field,
    title: field,
    headerSort: true,
    headerMenuIcon: '&#8942;',
    headerMenu: buildHeaderMenu(),
    // The actual sort-not-working fix — see detectSorter()'s comment above.
    sorter: detectSorter(field),
    // Still correct and now actually takes effect: pins null/empty cells to
    // the bottom regardless of sort direction, for both sorters above.
    sorterParams: { alignEmptyValues: 'bottom' },
  }));
}

const table = new Tabulator('#result-table', {
  data: rows,
  columns: buildColumnDefs(),
  // Bug fix: 'fitDataFill' remeasures every cell's rendered content on every
  // redraw to compute fill widths — expensive on a real result set, and the
  // direct cause of the reported hang/lag (every column-menu action below
  // calls redraw). 'fitColumns' sizes columns proportionally from the header
  // definitions alone, no per-cell content pass. "Autosize" is still covered
  // explicitly by the toolbar button/menu item this package already added.
  layout: 'fitColumns',
  height: '100%',
  movableColumns: true,
});

function findColumn(field: string): ColumnComponent | undefined {
  return table.getColumns().find(c => c.getField() === field);
}

// Pin Column (left/right/none). Tabulator's FrozenColumns module derives a
// column's frozen side purely from its position among the other frozen/
// unfrozen columns at redraw time (left-to-right scan; the side flips to
// "right" the moment a non-frozen column has been seen) — there's no direct
// per-column "pin right" flag independent of order. So pinning also moves
// the column to the corresponding edge, which is standard pin UX anyway
// (Excel/AG-Grid do the same). Ceiling: if literally every other column is
// already pinned left, "Pin Right" on the last remaining column still
// renders as left (no non-frozen column left in the scan to flip the mode) —
// an edge case not worth a bigger module for.
function pinColumn(field: string, pos: 'left' | 'right' | 'none') {
  const col = findColumn(field);
  if (!col) return;
  if (pos === 'none') {
    col.updateDefinition({ frozen: false });
  } else {
    const edge = pos === 'left' ? table.getColumns()[0] : table.getColumns()[table.getColumns().length - 1];
    if (edge && edge.getField() !== field) col.move(edge.getField(), pos === 'right');
    col.updateDefinition({ frozen: true });
  }
  table.redraw(true);
}

// `redraw()` (no `true`) below, not a full relayout: these three only change
// a formatter/cssClass on one column, never column order/width/visibility —
// `redraw(true)` forces Tabulator to remeasure and reposition every column,
// which is real work on a wide/large result set for no benefit here. Only
// `pinColumn` above genuinely changes column order/frozen state and needs it.
function setFormat(field: string, key: keyof typeof FORMATTERS) {
  const col = findColumn(field);
  if (!col) return;
  col.updateDefinition(FORMATTERS[key]);
  table.redraw();
}

function toggleWrap(field: string) {
  wrapped.has(field) ? wrapped.delete(field) : wrapped.add(field);
  const col = findColumn(field);
  col?.updateDefinition({ cssClass: cssClassFor(field) });
  table.redraw();
}

// "Select Column" — Tabulator's selection modules (SelectRow/SelectRange) are
// row/cell-range based, there's no built-in "select this whole column"
// concept to hook into. A per-column CSS highlight toggle (cssClass, same
// mechanism as Wrap above) is the simplest-correct stand-in the spec allows
// for ("reuse Tabulator's native ... or simplest-correct ... your call").
function toggleSelect(field: string) {
  selected.has(field) ? selected.delete(field) : selected.add(field);
  const col = findColumn(field);
  col?.updateDefinition({ cssClass: cssClassFor(field) });
  table.redraw();
}

function copyName(field: string) {
  navigator.clipboard.writeText(field);
}

function buildHeaderMenu() {
  return function (_e: MouseEvent, column: ColumnComponent) {
    const f = column.getField();
    return [
      { label: 'Sort Ascending', action: () => table.setSort(f, 'asc') },
      { label: 'Sort Descending', action: () => table.setSort(f, 'desc') },
      { separator: true },
      { label: selected.has(f) ? 'Deselect Column' : 'Select Column', action: () => toggleSelect(f) },
      {
        label: 'Pin Column',
        menu: [
          { label: 'Pin Left', action: () => pinColumn(f, 'left') },
          { label: 'Pin Right', action: () => pinColumn(f, 'right') },
          { label: 'No Pin', action: () => pinColumn(f, 'none') },
        ],
      },
      { label: wrapped.has(f) ? 'Unwrap Column Text' : 'Wrap Column Text', action: () => toggleWrap(f) },
      {
        label: 'Format',
        menu: [
          { label: 'Plain Text', action: () => setFormat(f, 'plaintext') },
          { label: 'Number (1,234)', action: () => setFormat(f, 'money') },
          { label: 'Date', action: () => setFormat(f, 'date') },
        ],
      },
      { separator: true },
      { label: 'Autosize This Column', action: () => column.setWidth(true) },
      { label: 'Group by This Column', action: () => table.setGroupBy(f) },
      { label: 'Hide Column', action: () => column.hide() },
      { separator: true },
      { label: 'Copy Name', action: () => copyName(f) },
    ];
  };
}

// --- toolbar: the genuinely table-wide actions, not per-column ---

document.getElementById('btn-autosize-all')?.addEventListener('click', () => {
  table.getColumns().forEach(c => c.setWidth(true));
});

document.getElementById('btn-reset')?.addEventListener('click', () => {
  wrapped.clear();
  selected.clear();
  table.setColumns(buildColumnDefs());
  table.setGroupBy(false as any);
  table.clearSort();
});

const choosePanel = document.getElementById('choose-columns-panel') as HTMLElement | null;
const chooseButton = document.getElementById('btn-choose-columns');
chooseButton?.addEventListener('click', (e) => {
  if (!choosePanel) return;
  e.stopPropagation(); // don't let this same click reach the document listener below and instantly re-close it
  choosePanel.hidden = !choosePanel.hidden;
  if (!choosePanel.hidden) renderChoosePanel();
});

// Bug fix: the panel previously only closed by clicking the toggle button
// again — no dismissal on an outside click, so it stayed open (and, being
// absolutely positioned over the grid, in the way) after picking a column.
// Standard dropdown-dismiss pattern: close on any click outside the panel
// and its own toggle button. Checkbox clicks inside the panel are excluded
// so toggling multiple columns in one open doesn't close it after each one.
document.addEventListener('click', (e) => {
  if (!choosePanel || choosePanel.hidden) return;
  const target = e.target as Node;
  if (!choosePanel.contains(target) && target !== chooseButton) {
    choosePanel.hidden = true;
  }
});

function renderChoosePanel() {
  if (!choosePanel) return;
  choosePanel.innerHTML = '';
  table.getColumns().forEach(col => {
    const field = col.getField();
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = col.isVisible();
    cb.addEventListener('change', () => (cb.checked ? col.show() : col.hide()));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(field));
    choosePanel.appendChild(label);
  });
}
