import { EventEmitter, TreeDataProvider, TreeView, window, ExtensionContext } from 'vscode';
import { OutputTreeItem } from './tree-items';
import ResultCapture from '../capture';

export class OutputExplorer implements TreeDataProvider<OutputTreeItem> {
  private treeView: TreeView<OutputTreeItem>;
  private _onDidChangeTreeData = new EventEmitter<OutputTreeItem | undefined>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private capture: ResultCapture, context: ExtensionContext) {
    this.treeView = window.createTreeView('sqltoolsChartsViewOutput', { treeDataProvider: this });
    context.subscriptions.push(this.treeView);
    context.subscriptions.push(capture.onDidChange(() => this.refresh()));
  }

  public getTreeItem(element: OutputTreeItem): OutputTreeItem {
    return element;
  }

  public getChildren(): OutputTreeItem[] {
    return this.capture.getEntries().map(entry => new OutputTreeItem(entry));
  }

  public refresh = () => {
    this._onDidChangeTreeData.fire(undefined);
  };
}

export default OutputExplorer;
