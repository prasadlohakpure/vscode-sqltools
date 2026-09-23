import { window, ViewColumn, ExtensionContext } from 'vscode';
import * as fs from 'fs';
import ResultCapture, { CaptureEntry } from '../capture';

const CHART_TYPES: { value: string; label: string }[] = [
  { value: 'column', label: 'Column' },
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
  { value: 'polar', label: 'Polar' },
  { value: 'scatter', label: 'Scatter' },
  { value: 'combination', label: 'Combination' },
];
// ponytail: Statistical/boxplot (chartjs-chart-boxplot), Hierarchical/treemap
// (chartjs-chart-treemap) and Funnel (chartjs-chart-funnel) all need their
// own Chart.js plugin package, not just config — out of scope for this pass.
// Upgrade path: add the specific package above and register its controller
// in webview-entry.ts when one of these is actually needed.

// first non-numeric column = labels, first numeric column = values. Used
// only to pre-select the config UI's dropdowns so the zero-interaction case
// still renders something immediately; the webview lets the user override
// both from the full column list once open.
function pickDefaults(cols: string[], rows: any[]): { labelCol: string; valueCol: string } {
  const sample = rows[0] as any;
  const numericCols = cols.filter(c => typeof sample[c] === 'number');
  const nonNumericCols = cols.filter(c => typeof sample[c] !== 'number');
  const labelCol = nonNumericCols[0] || cols[0];
  const valueCol = numericCols[0] || cols.find(c => c !== labelCol) || cols[0];
  return { labelCol, valueCol };
}

function hasChartableData(entry: CaptureEntry): boolean {
  const cols = entry.result.cols || [];
  const rows = entry.result.results || [];
  return cols.length > 0 && rows.length > 0;
}

/**
 * Opens the chart webview for one specific captured entry. Shared by both
 * "Chart Last Result" (title bar, always the newest entry) and "Chart This
 * Result" (per-row in the Query Output panel, any entry) — same webview,
 * same config UI, just a different entry picked before calling in.
 */
export function openChartWebview(context: ExtensionContext, entry: CaptureEntry, title = 'Chart Result'): void {
    const cols = entry.result.cols || [];
    const rows = entry.result.results as any[];
    const { labelCol, valueCol } = pickDefaults(cols, rows);

    const panel = window.createWebviewPanel('sqltoolsChartsChart', `Chart: ${title}`, ViewColumn.Active, {
      enableScripts: true,
    });

    const bundlePath = context.asAbsolutePath('out/chart-webview.js');
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    const dataJson = JSON.stringify({ cols, rows, defaultLabelCol: labelCol, defaultValueCol: valueCol });
    const chartTypeOptions = CHART_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('');

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  #chart-controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  #chart-controls label { display: block; font-size: 12px; margin-bottom: 4px; }
  #chart-controls select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
  fieldset { border: 1px solid var(--vscode-panel-border); }
  .value-col-option { display: flex; align-items: center; gap: 4px; font-size: 12px; }
</style>
</head>
<body>
  <div id="chart-controls">
    <div>
      <label for="chartType">Chart type</label>
      <select id="chartType">${chartTypeOptions}</select>
    </div>
    <div>
      <label for="labelCol">X-axis / labels</label>
      <select id="labelCol"></select>
    </div>
    <fieldset>
      <legend>Y-axis / values</legend>
      <div id="valueCols"></div>
    </fieldset>
  </div>
  <canvas id="chart"></canvas>
  <script>window.__CHART_DATA__ = ${dataJson};</script>
  <script>${bundle}</script>
</body>
</html>`;
}

/**
 * "Chart Last Result" — always the newest captured entry, regardless of which
 * connection or view triggered it. Registered against the view-title button.
 */
export function chartLastResultHandler(context: ExtensionContext, capture: ResultCapture) {
  return () => {
    const entry = capture.getLatest();
    if (!entry || entry.status !== 'success' || !hasChartableData(entry)) {
      window.showInformationMessage('SQLTools Charts: no data yet — run a query first.');
      return;
    }
    openChartWebview(context, entry, 'Last Result');
  };
}

/**
 * "Chart This Result" — a specific row from the Query Output panel, passed in
 * as the tree item VS Code hands the command (same pattern `openResult`
 * already uses). Lets you chart any past query, not just the most recent one.
 */
export function chartResultHandler(context: ExtensionContext) {
  return (item?: { entry?: CaptureEntry }) => {
    const entry = item?.entry;
    if (!entry || entry.status !== 'success' || !hasChartableData(entry)) {
      window.showInformationMessage('SQLTools Charts: this result has no chartable data.');
      return;
    }
    openChartWebview(context, entry, entry.query.replace(/\s+/g, ' ').trim().slice(0, 40));
  };
}
