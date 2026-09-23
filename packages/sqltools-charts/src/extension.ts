import { IExtension, IExtensionPlugin } from '@sqltools/types';
import { ExtensionContext, extensions, commands } from 'vscode';
import ResultCapture from './capture';
import OutputExplorer from './output';
import { OutputTreeItem } from './output/tree-items';
import { showResult } from './output/webview';
import { chartLastResultHandler, chartResultHandler } from './chart';
import FileBookmarksExplorer, {
  bookmarkFileHandler,
  openFileBookmarkHandler,
  removeFileBookmarkHandler,
  clearFileBookmarksHandler,
} from './filebookmarks';

export async function activate(context: ExtensionContext): Promise<void> {
  const sqltools = extensions.getExtension<IExtension>('mtxr.sqltools');
  if (!sqltools) {
    throw new Error('SQLTools not installed');
  }
  await sqltools.activate();

  const api = sqltools.exports;
  const capture = new ResultCapture();

  // Only used to reach addBeforeCommandHook/addAfterCommandSuccessHook —
  // our own commands are plain vscode commands below, not sqltools.* ones,
  // so there's no need to route them through extension.registerCommand.
  const plugin: IExtensionPlugin = {
    name: 'Charts & Query Output Plugin',
    type: 'plugin',
    register(extension: IExtension) {
      capture.register(extension);
    },
  };
  api.registerPlugin(plugin);

  // eslint-disable-next-line no-new -- registers itself into context.subscriptions
  new OutputExplorer(capture, context);

  // "Query execution should have the same view as Query Output's own 'Open
  // Result'" — auto-reveal the same rich (Tabulator) result view on every
  // completed query, not just when opened on demand from the panel. Safe to
  // do unconditionally now that showResult() reuses a single panel
  // (`activePanel.reveal()`) instead of spawning a new tab per call — this
  // was fixed alongside, since spawning one per query would otherwise flood
  // the editor with tabs the moment this ran automatically.
  //
  // `onDidChange` also fires on `clear()` (entries -> []), which must not
  // re-open anything — guarded by comparing the latest entry's own
  // `timestamp` against the last one already shown, so a genuine no-op
  // change (or clear, where getLatest() is undefined) never triggers this.
  let lastShownTimestamp: number | undefined;
  context.subscriptions.push(
    capture.onDidChange(() => {
      const latest = capture.getLatest();
      if (latest && latest.timestamp !== lastShownTimestamp) {
        lastShownTimestamp = latest.timestamp;
        showResult(latest);
      }
    }),
  );

  const fileBookmarks = new FileBookmarksExplorer(context);

  context.subscriptions.push(
    commands.registerCommand('sqltools-charts.chartLastResult', chartLastResultHandler(context, capture)),
    commands.registerCommand('sqltools-charts.chartResult', chartResultHandler(context)),
    commands.registerCommand('sqltools-charts.clearOutput', () => capture.clear()),
    commands.registerCommand('sqltools-charts.openResult', (item?: OutputTreeItem) => {
      if (item?.entry) showResult(item.entry);
    }),
    commands.registerCommand('sqltools-charts.bookmarkFile', bookmarkFileHandler(fileBookmarks)),
    commands.registerCommand('sqltools-charts.openFileBookmark', openFileBookmarkHandler(fileBookmarks)),
    commands.registerCommand('sqltools-charts.removeFileBookmark', removeFileBookmarkHandler(fileBookmarks)),
    commands.registerCommand('sqltools-charts.clearFileBookmarks', clearFileBookmarksHandler(fileBookmarks)),
  );
}

export function deactivate() {}
