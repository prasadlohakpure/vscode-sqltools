import * as path from 'path';
import * as fs from 'fs';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, Uri, workspace } from 'vscode';

export interface FileBookmark {
  path: string;
  addedAt: number;
}

// Bug fix: `getWorkspaceFolder` requires a genuine `Uri` — VS Code's real
// implementation calls URI-internal methods on the argument. The previous
// `{ fsPath: filePath } as never` was a type-checker bypass hiding that
// mismatch; at runtime it threw inside VS Code's own code on every tree
// refresh (visible as an error the moment a bookmark was added/removed,
// since that's what triggers the refresh). `Uri.file()` builds a real one.
function relativeOrAbsolute(filePath: string): string {
  const folder = workspace.getWorkspaceFolder(Uri.file(filePath));
  if (folder) return path.relative(folder.uri.fsPath, filePath);
  return filePath;
}

export class FileBookmarkTreeItem extends TreeItem {
  public contextValue = 'filebookmark.item';
  public readonly exists: boolean;

  constructor(public bookmark: FileBookmark) {
    const exists = fs.existsSync(bookmark.path);
    super(path.basename(bookmark.path), TreeItemCollapsibleState.None);
    this.exists = exists;
    this.description = exists ? relativeOrAbsolute(bookmark.path) : `${relativeOrAbsolute(bookmark.path)} (missing)`;
    this.tooltip = exists ? bookmark.path : `${bookmark.path}\nFile no longer exists`;
    this.iconPath = exists ? undefined : new ThemeIcon('warning');
    this.command = {
      title: 'Open File Bookmark',
      command: 'sqltools-charts.openFileBookmark',
      arguments: [this],
    };
  }
}
