import { TreeItem, TreeItemCollapsibleState } from 'vscode';
import { CaptureEntry } from '../capture';

function truncate(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export class OutputTreeItem extends TreeItem {
  public contextValue = 'output.item';

  constructor(public entry: CaptureEntry) {
    super(truncate(entry.query), TreeItemCollapsibleState.None);
    this.description = entry.status === 'success'
      ? `✓ ${entry.durationMs}ms · ${entry.rowCount} rows`
      : `✗ failed · ${entry.durationMs}ms`;
    this.tooltip = entry.query;
    this.command = {
      title: 'Open Result',
      command: 'sqltools-charts.openResult',
      arguments: [this],
    };
  }
}
