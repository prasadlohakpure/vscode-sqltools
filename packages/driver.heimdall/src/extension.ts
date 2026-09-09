import { IConnection, IExtension, IExtensionPlugin, IDriverExtensionApi } from '@sqltools/types';
import { commands, ExtensionContext, extensions, window } from 'vscode';
import { DRIVER_ALIASES } from './constants';
import { needsConfirmation, statementAt } from './gate';
import { CLEAR_METADATA, MetadataRequestParams, MetadataRequestResult, REFRESH_METADATA, TARGET_MISMATCH, TargetMismatchParams } from './ipc';
const { publisher, name } = require('../package.json');

const driverName = 'Heimdall';
const HEIMDALL_DRIVERS = new Set(DRIVER_ALIASES.map(({ value }) => value));

/**
 * SQLTools' own `getConnections` ext command (registered by
 * `connection-manager`) is the only way to learn the active connection from
 * out here — `@sqltools/util/connection`'s `getConnectionId` etc. are not a
 * dependency of this package (package.json is pre-wired, out of scope for
 * UoW-01), so `id` is used with a `name` fallback rather than reimplementing it.
 */
async function getActiveConnection(): Promise<IConnection | undefined> {
  try {
    const connections = await commands.executeCommand<IConnection[]>('sqltools.getConnections', { connectedOnly: true });
    return connections?.find((c) => c.isActive) ?? connections?.[0];
  } catch {
    return undefined;
  }
}

/** FR-1: the gate must not interfere with a non-Heimdall connection in the same window. */
async function isHeimdallConnectionActive(): Promise<boolean> {
  const active = await getActiveConnection();
  return !!active && HEIMDALL_DRIVERS.has(active.driver as string);
}

/**
 * FR-1: modal confirmation when `sql` holds a non-read-only statement.
 * Resolves `true` to proceed (nothing to check, or the user confirmed) and
 * `false` to abort — the caller must then submit nothing.
 */
async function confirmIfUnsafe(sql: string): Promise<boolean> {
  if (!needsConfirmation(sql)) {
    return true;
  }
  const choice = await window.showWarningMessage(
    'Heimdall: this query is not read-only (not SELECT/SHOW/DESCRIBE/EXPLAIN/WITH). Run anyway?',
    { modal: true },
    'Run anyway',
  );
  return choice === 'Run anyway';
}

function currentQueryText(): string {
  const editor = window.activeTextEditor;
  if (!editor) {
    return '';
  }
  if (!editor.selection.isEmpty) {
    return editor.document.getText(editor.selection);
  }
  return statementAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active));
}

/**
 * FR-1: the gated wrapper shared by both commands below — check, confirm if
 * needed, and only then delegate to the native SQLTools command. `nativeCommand`
 * is invoked with no arguments, same as the keybindings/palette entries it
 * replaces, so SQLTools re-derives selection/current-statement itself.
 */
async function gatedExecute(nativeCommand: string): Promise<unknown> {
  if (await isHeimdallConnectionActive()) {
    const proceed = await confirmIfUnsafe(currentQueryText());
    if (!proceed) {
      void window.showInformationMessage('Heimdall: run cancelled, nothing was submitted.');
      return;
    }
  }
  return commands.executeCommand(nativeCommand);
}

/** Thin ext->LS metadata command: sends the request, toasts the result, never throws. */
function registerMetadataCommand(
  context: ExtensionContext,
  extension: IExtension,
  command: string,
  method: string,
  fallbackMessage: string,
): void {
  context.subscriptions.push(
    commands.registerCommand(command, async () => {
      const active = await getActiveConnection();
      if (!active) {
        void window.showWarningMessage('Heimdall: no active connection — connect first.');
        return;
      }
      try {
        const params: MetadataRequestParams = { connId: String(active.id ?? active.name) };
        const result = await extension.client.sendRequest<MetadataRequestResult>(method, params);
        void window.showInformationMessage(`Heimdall: ${result.message}`);
        await commands.executeCommand('sqltools.refreshTree');
      } catch (error) {
        void window.showErrorMessage(`Heimdall: ${fallbackMessage} — ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}

export async function activate(extContext: ExtensionContext): Promise<IDriverExtensionApi> {
  const sqltools = extensions.getExtension<IExtension>('mtxr.sqltools');
  if (!sqltools) {
    throw new Error('SQLTools not installed');
  }
  await sqltools.activate();

  const api = sqltools.exports;

  const extensionId = `${publisher}.${name}`;
  const plugin: IExtensionPlugin = {
    extensionId,
    name: `${driverName} Plugin`,
    type: 'driver',
    async register(extension) {
      // register ext part here
      extension.resourcesMap().set(`driver/${DRIVER_ALIASES[0].value}/icons`, {
        active: extContext.asAbsolutePath('icons/active.png'),
        default: extContext.asAbsolutePath('icons/default.png'),
        inactive: extContext.asAbsolutePath('icons/inactive.png'),
      });
      DRIVER_ALIASES.forEach(({ value }) => {
        extension.resourcesMap().set(`driver/${value}/extension-id`, extensionId);
        extension.resourcesMap().set(`driver/${value}/connection-schema`, extContext.asAbsolutePath('connection.schema.json'));
        extension.resourcesMap().set(`driver/${value}/ui-schema`, extContext.asAbsolutePath('ui.schema.json'));
      });
      await extension.client.sendRequest('ls/RegisterPlugin', { path: extContext.asAbsolutePath('out/ls/plugin.js') });

      // FR-1: gated command wrappers. `package.json` (pre-wired) already
      // contributes both commands under the "Heimdall" category and gives
      // `executeCurrentQuery` the no-selection chord / `executeQuery` the
      // has-selection chord.
      //
      // ponytail: two extensions contributing the same chord is not
      // deterministic in VS Code, so the guarded command is only guaranteed
      // to win on the no-selection chord (SQLTools itself contributes no
      // `executeCurrentQuery` binding) and via the command palette — the
      // has-selection chord may resolve to either extension's binding.
      // Escape hatch: `sqltools.disableChordKeybindings: true` deactivates
      // all of SQLTools' own chords (they're all guarded by
      // `!config.sqltools.disableChordKeybindings`; ours are not), making
      // ours win deterministically. Upgrade path is an LS->ext confirm
      // request from inside `driver.query()` itself, which no launch path
      // (chord, palette, or a future one) could bypass — deferred because
      // `query()` is fenced as live-verified this pass.
      extContext.subscriptions.push(
        commands.registerCommand('sqltools-driver-heimdall.executeQuery', () => gatedExecute('sqltools.executeQuery')),
        commands.registerCommand('sqltools-driver-heimdall.executeCurrentQuery', () => gatedExecute('sqltools.executeCurrentQuery')),
      );
      registerMetadataCommand(
        extContext,
        extension,
        'sqltools-driver-heimdall.refreshMetadata',
        REFRESH_METADATA,
        'refresh metadata failed',
      );
      registerMetadataCommand(
        extContext,
        extension,
        'sqltools-driver-heimdall.clearMetadata',
        CLEAR_METADATA,
        'clear metadata failed',
      );

      // US-2/FR-2: loud, un-scrollable-past notification on a real target
      // mismatch — sent from `ls/driver.ts`'s `query()` (see `./ipc.ts`).
      // Plain error toast, not modal (US-2 doesn't ask for modal). The
      // merely-`unverified` state never sends this notification at all, so
      // there is nothing to filter here.
      extension.client.onNotification(TARGET_MISMATCH, (params: TargetMismatchParams) => {
        void window.showErrorMessage(`Heimdall: ${params.message}`);
      });
    }
  };
  api.registerPlugin(plugin);
  return {
    driverName,
    parseBeforeSaveConnection: ({ connInfo }) => connInfo,
    parseBeforeEditConnection: ({ connInfo }) => connInfo,
    driverAliases: DRIVER_ALIASES,
  }
}

export function deactivate() {}
