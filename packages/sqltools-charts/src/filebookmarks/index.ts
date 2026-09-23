import * as fs from 'fs';
import { EventEmitter, TreeDataProvider, TreeView, window, workspace, ExtensionContext } from 'vscode';
import { FileBookmark, FileBookmarkTreeItem } from './tree-items';

const STORAGE_KEY = 'sqltools-charts.fileBookmarks';

export class FileBookmarksExplorer implements TreeDataProvider<FileBookmarkTreeItem> {
  private treeView: TreeView<FileBookmarkTreeItem>;
  private _onDidChangeTreeData = new EventEmitter<FileBookmarkTreeItem | undefined>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private context: ExtensionContext) {
    this.treeView = window.createTreeView('sqltoolsChartsViewFileBookmarks', { treeDataProvider: this });
    context.subscriptions.push(this.treeView);
  }

  private getBookmarks(): FileBookmark[] {
    return this.context.globalState.get<FileBookmark[]>(STORAGE_KEY, []);
  }

  private async setBookmarks(bookmarks: FileBookmark[]): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, bookmarks);
    this.refresh();
  }

  public getTreeItem(element: FileBookmarkTreeItem): FileBookmarkTreeItem {
    return element;
  }

  public getChildren(): FileBookmarkTreeItem[] {
    return this.getBookmarks()
      .slice()
      .sort((a, b) => b.addedAt - a.addedAt)
      .map(bookmark => new FileBookmarkTreeItem(bookmark));
  }

  public refresh = () => {
    this._onDidChangeTreeData.fire(undefined);
  };

  public async bookmarkFile(filePath: string): Promise<void> {
    const existing = this.getBookmarks().filter(b => b.path !== filePath);
    existing.push({ path: filePath, addedAt: Date.now() });
    await this.setBookmarks(existing);
  }

  public async removeBookmark(filePath: string): Promise<void> {
    await this.setBookmarks(this.getBookmarks().filter(b => b.path !== filePath));
  }

  public async clear(): Promise<void> {
    await this.setBookmarks([]);
  }
}

export function bookmarkFileHandler(explorer: FileBookmarksExplorer) {
  return async () => {
    const editor = window.activeTextEditor;
    if (!editor) {
      window.showInformationMessage('No active editor to bookmark.');
      return;
    }
    await explorer.bookmarkFile(editor.document.uri.fsPath);
  };
}

export function openFileBookmarkHandler(explorer: FileBookmarksExplorer) {
  return async (item?: FileBookmarkTreeItem) => {
    if (!item?.bookmark) return;
    if (!fs.existsSync(item.bookmark.path)) {
      const choice = await window.showWarningMessage(
        `File no longer exists: ${item.bookmark.path}. Remove this bookmark?`,
        'Remove',
        'Cancel',
      );
      if (choice === 'Remove') await explorer.removeBookmark(item.bookmark.path);
      return;
    }
    const doc = await workspace.openTextDocument(item.bookmark.path);
    await window.showTextDocument(doc);
  };
}

export function removeFileBookmarkHandler(explorer: FileBookmarksExplorer) {
  return async (item?: FileBookmarkTreeItem) => {
    if (!item?.bookmark) return;
    await explorer.removeBookmark(item.bookmark.path);
  };
}

export function clearFileBookmarksHandler(explorer: FileBookmarksExplorer) {
  return async () => {
    await explorer.clear();
  };
}

export default FileBookmarksExplorer;
