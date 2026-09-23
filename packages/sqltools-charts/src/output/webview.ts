import { window, ViewColumn } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CaptureEntry } from '../capture';

function esc(v: any): string {
  return String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

// Tabulator's own CSS ("simple" theme — least opinionated base to override),
// compiled at build time into out/output-webview.css (see package.json's
// compile:output-css) and read from there — NOT via `require.resolve()`
// into `node_modules` at runtime. This is a yarn workspace: tabulator-tables
// hoists to the repo-root node_modules, not this package's own, so it is
// never present inside the installed extension's directory — a packaged
// .vsix was confirmed to ship without it. Reading our own out/ build output
// (guaranteed present, same as the JS bundle below) is the fix.
// Lazily cached: every showResult() call reuses it instead of re-reading.
let tabulatorCss: string | undefined;
function getTabulatorCss(): string {
  if (tabulatorCss === undefined) {
    tabulatorCss = fs.readFileSync(path.join(__dirname, 'output-webview.css'), 'utf8');
  }
  return tabulatorCss;
}

// Reused across calls instead of spawning a new panel every time — every
// prior call created a brand-new tab, so repeated use (manual or, once
// wired to auto-open on every query execution, automatic) would flood the
// editor with tabs. `undefined` once the user closes it, so the next call
// creates a fresh one rather than throwing on a disposed panel.
let activePanel: import('vscode').WebviewPanel | undefined;

export function showResult(entry: CaptureEntry) {
  if (activePanel) {
    activePanel.reveal(ViewColumn.Active);
  } else {
    activePanel = window.createWebviewPanel('sqltoolsChartsResult', 'Query Result', ViewColumn.Active, { enableScripts: true });
    activePanel.onDidDispose(() => { activePanel = undefined; });
  }
  const panel = activePanel;

  if (entry.status === 'error') {
    panel.webview.html = `<!DOCTYPE html><html><body>
      <h3>Query failed</h3>
      <pre>${esc(entry.query)}</pre>
      <pre style="color:var(--vscode-errorForeground)">${esc(entry.result.error)}</pre>
    </body></html>`;
    return;
  }

  const cols = entry.result.cols || [];
  const rows = entry.result.results || [];
  const dataJson = JSON.stringify({ cols, rows });
  // out/extension.js (this code, bundled) and out/output-webview.js are
  // built as siblings in the same out/ folder — see package.json's
  // compile:ext / compile:output-webview scripts — so __dirname at runtime
  // already points at it.
  const bundlePath = path.join(__dirname, 'output-webview.js');
  const bundle = fs.readFileSync(bundlePath, 'utf8');

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>${getTabulatorCss()}</style>
<style>
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; margin: 0; padding: 8px; box-sizing: border-box; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  pre { white-space: pre-wrap; margin: 0 0 4px; }
  #result-meta { margin: 0 0 8px; font-size: 12px; }
  #grid-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; position: relative; }
  #grid-toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); padding: 2px 8px; font-size: 12px; cursor: pointer; }
  #grid-toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #choose-columns-panel { position: absolute; top: 100%; left: 0; z-index: 10; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); padding: 6px 10px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
  #choose-columns-panel label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  #result-table { flex: 1; min-height: 0; }

  /* Tabulator theme overrides — the "simple" CSS above is light-themed by
     default, this remaps it onto VS Code's own theme variables so it matches
     whatever color theme the user has active (light/dark/high-contrast). */
  .tabulator { background-color: var(--vscode-editor-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); font-size: 12px; }
  .tabulator .tabulator-header { background-color: var(--vscode-editorWidget-background); color: var(--vscode-foreground); border-bottom: 1px solid var(--vscode-panel-border); }
  .tabulator .tabulator-header .tabulator-col { background-color: var(--vscode-editorWidget-background); border-right: 1px solid var(--vscode-panel-border); }
  .tabulator .tabulator-header .tabulator-col.tabulator-sortable:hover { background-color: var(--vscode-list-hoverBackground); }
  .tabulator-row { background-color: var(--vscode-editor-background); color: var(--vscode-foreground); }
  .tabulator-row.tabulator-row-even { background-color: var(--vscode-editor-background); }
  .tabulator-row:hover { background-color: var(--vscode-list-hoverBackground) !important; }
  .tabulator-row .tabulator-cell { border-right: 1px solid var(--vscode-panel-border); }
  .tabulator .tabulator-tableholder { background-color: var(--vscode-editor-background); }
  .tabulator-menu { background-color: var(--vscode-editorWidget-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
  .tabulator-menu .tabulator-menu-item { color: var(--vscode-foreground); }
  .tabulator-menu .tabulator-menu-item:hover { background-color: var(--vscode-list-hoverBackground); }
  .tabulator-menu .tabulator-menu-separator { border-bottom: 1px solid var(--vscode-panel-border); }
  .tabulator-col-resize-handle { background-color: var(--vscode-panel-border); }
  .tabulator .tabulator-footer { background-color: var(--vscode-editorWidget-background); color: var(--vscode-foreground); border-top: 1px solid var(--vscode-panel-border); }

  /* Wrap Column Text (per-column cssClass toggle, see webview-entry.ts) */
  .col-wrap .tabulator-cell { white-space: normal !important; word-break: break-word; }
  /* Select Column (per-column cssClass toggle, see webview-entry.ts) */
  .col-selected .tabulator-cell { background-color: var(--vscode-editor-selectionBackground); }
</style>
</head>
<body>
  <pre>${esc(entry.query)}</pre>
  <p id="result-meta">${entry.rowCount} rows &middot; ${entry.durationMs}ms</p>
  <div id="grid-toolbar">
    <button id="btn-autosize-all">Autosize All Columns</button>
    <button id="btn-reset">Reset Columns</button>
    <button id="btn-choose-columns">Choose Columns</button>
    <div id="choose-columns-panel" hidden></div>
  </div>
  <div id="result-table"></div>
  <script>window.__RESULT_DATA__ = ${dataJson};</script>
  <script>${bundle}</script>
</body>
</html>`;
}
