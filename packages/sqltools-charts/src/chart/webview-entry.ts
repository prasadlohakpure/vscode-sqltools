// Runs inside the webview (browser context), bundled separately from the
// extension-host code. `chart.js/auto` auto-registers every controller/scale
// so we don't have to hand-pick which pieces of Chart.js to register.
import Chart from 'chart.js/auto';

type ChartKind = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'polar' | 'scatter' | 'combination';

declare global {
  interface Window {
    __CHART_DATA__: {
      cols: string[];
      rows: Record<string, any>[];
      defaultLabelCol: string;
      defaultValueCol: string;
    };
  }
}

const { cols, rows, defaultLabelCol, defaultValueCol } = window.__CHART_DATA__;

// same heuristic as the extension-host default pick, applied per-column so the
// value checkboxes only offer columns that are actually numeric.
const numericCols = cols.filter(c => rows.length > 0 && typeof rows[0][c] === 'number');

const PALETTE = ['#4a9eda', '#e8834e', '#5fb87a', '#c775d1', '#e0c341', '#4ecdc4', '#e56b8f', '#9b8ee8'];

const chartTypeSelect = document.getElementById('chartType') as HTMLSelectElement;
const labelColSelect = document.getElementById('labelCol') as HTMLSelectElement;
const valueColsBox = document.getElementById('valueCols') as HTMLElement;
const canvas = document.getElementById('chart') as HTMLCanvasElement;

cols.forEach(c => {
  const opt = document.createElement('option');
  opt.value = c;
  opt.textContent = c;
  if (c === defaultLabelCol) opt.selected = true;
  labelColSelect.appendChild(opt);
});

numericCols.forEach(c => {
  const id = `vc-${c}`;
  const wrap = document.createElement('label');
  wrap.className = 'value-col-option';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = c;
  cb.id = id;
  cb.checked = c === defaultValueCol;
  cb.addEventListener('change', render);
  wrap.appendChild(cb);
  wrap.appendChild(document.createTextNode(c));
  valueColsBox.appendChild(wrap);
});

function getSelectedValueCols(): string[] {
  return numericCols.filter(c => (document.getElementById(`vc-${c}`) as HTMLInputElement)?.checked);
}

function setValueColsChecked(selected: string[]) {
  numericCols.forEach(c => {
    const cb = document.getElementById(`vc-${c}`) as HTMLInputElement;
    if (cb) cb.checked = selected.includes(c);
  });
}

let chart: Chart | undefined;

function buildConfig(type: ChartKind, labelCol: string, valueCols: string[]) {
  const labels = rows.map(r => String(r[labelCol]));

  // pie/polar/scatter are single-series chart types — only the first checked
  // value column applies.
  if (type === 'pie' || type === 'polar') {
    const col = valueCols[0];
    const data = rows.map(r => Number(r[col]));
    return {
      type: type === 'pie' ? 'pie' : 'polarArea',
      data: { labels, datasets: [{ label: col, data, backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]) }] },
      options: { responsive: true },
    } as const;
  }

  if (type === 'scatter') {
    const col = valueCols[0];
    // ponytail: no dedicated numeric x-axis column picker — scatter plots
    // value against row index unless the label column itself is numeric.
    // Upgrade path: a second numeric-column selector for the x axis.
    const data = rows.map((r, i) => ({ x: typeof r[labelCol] === 'number' ? r[labelCol] : i, y: Number(r[col]) }));
    return {
      type: 'scatter',
      data: { datasets: [{ label: col, data, backgroundColor: PALETTE[0] }] },
      options: { responsive: true },
    } as const;
  }

  if (type === 'combination') {
    const datasets = valueCols.map((col, i) => ({
      type: i === 0 ? 'bar' : 'line',
      label: col,
      data: rows.map(r => Number(r[col])),
      backgroundColor: PALETTE[i % PALETTE.length],
      borderColor: PALETTE[i % PALETTE.length],
    }));
    return {
      type: 'bar',
      data: { labels, datasets },
      options: { responsive: true, plugins: { legend: { display: true } } },
    } as const;
  }

  // column, bar, line, area
  const isLineFamily = type === 'line' || type === 'area';
  const datasets = valueCols.map((col, i) => ({
    label: col,
    data: rows.map(r => Number(r[col])),
    backgroundColor: PALETTE[i % PALETTE.length],
    borderColor: PALETTE[i % PALETTE.length],
    fill: type === 'area',
  }));
  return {
    type: isLineFamily ? 'line' : 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      indexAxis: type === 'bar' ? 'y' : 'x',
      plugins: { legend: { display: datasets.length > 1 } },
    },
  } as const;
}

function render() {
  const type = chartTypeSelect.value as ChartKind;
  const labelCol = labelColSelect.value;
  let valueCols = getSelectedValueCols();

  // sensible default for Combination: first numeric series as bars, second
  // as a line, when the user hasn't already picked at least two.
  if (type === 'combination' && valueCols.length < 2 && numericCols.length >= 2) {
    valueCols = numericCols.slice(0, 2);
    setValueColsChecked(valueCols);
  }
  if (valueCols.length === 0 && numericCols.length > 0) {
    valueCols = [numericCols[0]];
    setValueColsChecked(valueCols);
  }
  if (valueCols.length === 0) return;

  const config = buildConfig(type, labelCol, valueCols);
  if (chart) chart.destroy();
  chart = new Chart(canvas, config as any);
}

chartTypeSelect.addEventListener('change', render);
labelColSelect.addEventListener('change', render);

render();
