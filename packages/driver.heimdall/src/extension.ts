import { existsSync, readFileSync } from 'fs';
import { IConnection, IExtension, IExtensionPlugin, IDriverExtensionApi } from '@sqltools/types';
import { commands, ExtensionContext, extensions, window } from 'vscode';
import { COOKIE_MAX_AGE_DAYS, REFRESH_CMD, cookieAgeDays, cookieFileCandidates } from './heimdall/auth';
import { DRIVER_ALIASES } from './constants';
import { needsConfirmation, statementAt } from './gate';
import { CLEAR_METADATA, COOKIE_REFRESH_REQUIRED, CookieRefreshParams, MetadataRequestParams, MetadataRequestResult, REFRESH_METADATA, TARGET_MISMATCH, TargetMismatchParams } from './ipc';
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
 * FR-1: read-only only, for now — no "run anyway" escape here, because
 * `ls/driver.ts`'s `query()` hard-blocks the same statement server-side
 * regardless (the one path every execution route funnels through, including
 * ones this wrapper doesn't cover: Run from History, Run from Bookmarks,
 * right-click "Show Records"). Offering a confirm-to-proceed choice here
 * would be misleading — accepting it would just surface a second, blocked
 * result from the driver. This check exists only to give faster local
 * feedback before round-tripping to the language server at all.
 *
 * Resolves `true` to proceed (nothing to check) and `false` to abort — the
 * caller must then submit nothing.
 */
async function confirmIfUnsafe(sql: string): Promise<boolean> {
  if (!needsConfirmation(sql)) {
    return true;
  }
  void window.showErrorMessage(
    'Heimdall: only read-only statements (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) are allowed right now. Nothing was submitted.',
  );
  return false;
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
/**
 * Bug fix: UoW-08's cookie-monster offer previously only ran once, at
 * activation (`register()`, below) — a cookie that goes missing/stale mid-
 * session (exactly what happened here: present at activation, gone by the
 * time a query actually ran) got no offer at all, just the raw
 * `buildAuth()`/`HeimdallAuthError` message. Catches both failure shapes
 * `ls/driver.ts`'s `open()`/`buildAuth()` and `heimdall/client.ts`'s
 * `HeimdallAuthError` can throw — matched by message content (`cookie` or
 * `credentials`, case-insensitive) since both `buildAuth()`'s own errors and
 * a live 401/403/redirect from Heimdall itself use one of those two words in
 * every variant of the text (see auth.ts/client.ts's exact strings) — rather
 * than only the literal "no cookie file" phrasing, so a since-expired but
 * still-present cookie's runtime rejection triggers the same offer.
 */
function isAuthFailureMessage(message: string): boolean {
  return /cookie|credentials/i.test(message);
}

async function gatedExecute(nativeCommand: string): Promise<unknown> {
  if (await isHeimdallConnectionActive()) {
    const proceed = await confirmIfUnsafe(currentQueryText());
    if (!proceed) {
      void window.showInformationMessage('Heimdall: run cancelled, nothing was submitted.');
      return;
    }

    // Bug fix: the try/catch below can never see a failed query. Core
    // SQLTools' own `ext_executeQuery` swallows the error internally
    // (packages/plugins/connection-manager/extension.ts:
    // `catch (e) { this.errorHandler('Error fetching records.', e); }` —
    // no rethrow), so `commands.executeCommand('sqltools.executeQuery')`
    // resolves normally even when the query fails outright. Confirmed by
    // reading that handler, not assumed. The only place this is
    // interceptable at all is *before* delegating: check cookie freshness
    // proactively and offer the refresh ahead of a request that's already
    // known to be doomed, rather than trying (and failing) to react to it
    // afterward.
    // On request: no confirmation button — just run cookie-monster directly
    // the moment a bad cookie is detected. It opens a browser for Okta/MFA,
    // which the user completes themselves regardless of whether they had to
    // click a button first, so the extra click was pure friction. Still
    // aborts this run (nothing submitted) rather than proceeding — running a
    // query against a cookie already known to be broken can't succeed.
    const { status } = cookieStatus();
    if (status !== 'ok') {
      void window.showWarningMessage(
        status === 'missing'
          ? 'Heimdall: no Gatekeeper cookie file found — running cookie-monster, complete the browser/MFA prompt then retry.'
          : 'Heimdall: Gatekeeper cookie is stale — running cookie-monster, complete the browser/MFA prompt then retry.',
      );
      await runCookieRefresh();
      return;
    }
  }
  try {
    return await commands.executeCommand(nativeCommand);
  } catch (error) {
    // Defensive fallback only — the pre-check above is the actual fix for
    // the reported case. Kept in case some other path genuinely rejects
    // (e.g. a connection-open failure surfaced a different way than
    // executeQuery's own swallow-and-notify).
    const message = error instanceof Error ? error.message : String(error);
    if (isAuthFailureMessage(message) && (await isHeimdallConnectionActive())) {
      void window.showErrorMessage(`Heimdall: ${message} — running cookie-monster.`);
      await runCookieRefresh();
      return;
    }
    throw error; // not auth-related — let SQLTools' own error handling show it as usual
  }
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

/**
 * UoW-08: is the on-disk Gatekeeper cookie usable right now? Mirrors
 * `buildAuth()`'s own lookup order (first candidate file that exists wins) —
 * `auth.ts` owns that order, this just reads the same candidates rather than
 * re-deriving them. A corrupt/unreadable file is treated the same as
 * `stale`: either way the fix is the same refresh command.
 */
function cookieStatus(): { status: 'ok' | 'stale' | 'missing'; path?: string } {
  for (const path of cookieFileCandidates()) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { when_created?: number };
      if (typeof parsed.when_created === 'number' && cookieAgeDays(parsed.when_created) > COOKIE_MAX_AGE_DAYS) {
        return { status: 'stale', path };
      }
      return { status: 'ok', path };
    } catch {
      return { status: 'stale', path };
    }
  }
  return { status: 'missing' };
}

/**
 * UoW-08: run cookie-monster in a *visible* integrated terminal — it opens a
 * browser and may need an MFA tap, so a hidden child_process would strand the
 * user mid-auth with nothing to look at. No completion detection: that would
 * mean fragile terminal-output parsing, so this just tells the user to retry
 * once the browser flow completes.
 *
 * Bug fix: this used to run `mise run agent-sandbox:auth` in a located
 * `data-airflow` checkout (a whole `findDataAirflowRepo()` helper — remembered
 * globalState path, sibling-directory guess, `showOpenDialog` fallback — all
 * deleted here). Two real problems with that: `mise` proved unreliable to
 * invoke from an automated terminal (not found in at least one shell context
 * this session hit), and the repo/cwd was never actually needed — the real
 * tool, `cookie-monster`, is a standalone binary on `$PATH` that runs from
 * anywhere. `REFRESH_CMD` (`heimdall/auth.ts`) now calls it directly with no
 * `cwd` requirement, so all of that lookup machinery is just gone.
 *
 * Reuses the terminal by name across repeated calls (activation, and every
 * gated command, can each trigger this while the cookie is bad) so two
 * close-together triggers don't spawn a second terminal and a second browser
 * tab on top of the first.
 */
const COOKIE_REFRESH_TERMINAL_NAME = 'Heimdall: Gatekeeper cookie refresh';

async function runCookieRefresh(): Promise<void> {
  const existing = window.terminals.find((t) => t.name === COOKIE_REFRESH_TERMINAL_NAME);
  if (existing) {
    existing.show();
    return;
  }
  const terminal = window.createTerminal({ name: COOKIE_REFRESH_TERMINAL_NAME });
  terminal.show();
  terminal.sendText(REFRESH_CMD);
  void window.showInformationMessage(
    'Heimdall: cookie refresh started — complete the browser/MFA prompt in the terminal, then retry your connection.',
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
      // contributes both commands under the "Heimdall" category and binds
      // both to a single `Cmd+Enter`/`Ctrl+Enter` keypress (changed twice on
      // request: chord `Cmd+E Cmd+E` -> single `Cmd+E` -> `Cmd+Enter`),
      // split by `editorHasSelection` the same way as before.
      //
      // ponytail: checked every installed extension's contributed
      // keybindings before this change (not just core SQLTools). Real,
      // confirmed collision found: cweijan.vscode-mysql-client2's
      // `mysql.runSQL` is also bound to `Cmd+Enter` for
      // `editorLangId =~ /sql|cql|postgres/` with a selection — the identical
      // trigger surface as this driver's `executeQuery`. VS Code does not
      // guarantee which extension wins a same-key/overlapping-`when`
      // collision (effectively load-order dependent), so this may misfire
      // for either extension while both are installed. Escape hatch: rebind
      // one of the two in your own keybindings.json, or disable whichever
      // extension you're not using for a given connection. (SQLTools core
      // itself contributes no `Cmd+Enter` binding — only third-party
      // extensions collide here.) Upgrade path for a real fix regardless of
      // keybinding choice: an LS->ext confirm request from inside
      // `driver.query()` itself (no launch path could bypass it), deferred
      // because `query()` is fenced as live-verified this pass.
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

      // Bug fix: connecting used to dead-end at core SQLTools' "Error opening
      // connection: No Gatekeeper cookie file found ... Run `...`" toast,
      // leaving the user to copy the command into a terminal themselves. The
      // command-level pre-checks below (`gatedExecute`, and the
      // `addBeforeCommandHook`s) can't cover that: at connect time there is no
      // connected Heimdall connection yet, so `isHeimdallConnectionActive()`
      // is false and nothing fires. `ls/driver.ts`'s `buildAuth()` — the one
      // place every credential read funnels through, connect included —
      // now reports the bad cookie here instead (see `./ipc.ts`), and this
      // runs the refresh on its behalf.
      extension.client.onNotification(COOKIE_REFRESH_REQUIRED, (params: CookieRefreshParams) => {
        void window.showWarningMessage(
          `Heimdall: Gatekeeper cookie is ${params.reason}${params.path ? ` (${params.path})` : ''} — running cookie-monster, complete the browser/MFA prompt then retry.`,
        );
        void runCookieRefresh();
      });

      // UoW-08: `refreshCookie` command (package.json pre-wired) plus an
      // activation-time nudge when a Heimdall connection is already active
      // and its Gatekeeper cookie is stale/missing. Skipped entirely when no
      // Heimdall connection exists in this window — nothing to nag about.
      extContext.subscriptions.push(
        commands.registerCommand('sqltools-driver-heimdall.refreshCookie', () => runCookieRefresh()),
      );
      // Bug fix: this used to `await` the connection check and the warning
      // toast's dismissal right here in `register()` — SQLTools core calls
      // and presumably awaits this callback during activation, so blocking
      // it on the user dismissing a prompt (or on a `getConnections` round
      // trip to the language server before it may even be ready) held up
      // whatever depends on registration completing. Fire-and-forget: none
      // of this needs to happen before `register()` returns.
      void (async () => {
        if (await isHeimdallConnectionActive()) {
          const { status } = cookieStatus();
          if (status !== 'ok') {
            // On request: run cookie-monster directly, no confirmation
            // button — same reasoning as gatedExecute's pre-check above.
            void window.showWarningMessage(
              status === 'missing'
                ? 'Heimdall: no Gatekeeper cookie file found — running cookie-monster, complete the browser/MFA prompt then retry.'
                : 'Heimdall: Gatekeeper cookie is stale — running cookie-monster, complete the browser/MFA prompt then retry.',
            );
            await runCookieRefresh();
          }
        }
      })();

      // Bug fix: "Error fetching records" (and the equivalent from Show
      // Records / History / Bookmarks) is core SQLTools' OWN internal
      // catch-and-notify — `packages/plugins/connection-manager/
      // extension.ts` never rethrows, so it happens whenever any of these
      // *core* commands run, regardless of whether that came from our
      // gated `sqltools-driver-heimdall.*` commands (already covered by
      // `gatedExecute`'s pre-check above) or a path that calls core's own
      // command directly — a stale/missing keybinding resolving to core's
      // binding instead of ours, the Command Palette's un-prefixed
      // "SQLTools: Execute Query" entry, Show Records, Run from History,
      // Run from Bookmarks. No public hook can *veto* a core command (only
      // `addBeforeCommandHook`/`addAfterCommandSuccessHook`, both
      // observers — confirmed by reading `IExtension`'s type, and
      // monkey-patching `extension.errorHandler` doesn't work either: it's
      // copied by value into the plugin-facing object, not the live
      // instance core calls internally). This is the closest available:
      // fire cookie-monster in parallel the instant any of these are
      // attempted while the cookie is bad, covering every entry point even
      // though the native "Error fetching records" toast still also shows.
      ['executeQuery', 'executeCurrentQuery', 'showRecords', 'runFromHistory', 'runFromBookmarks'].forEach((cmd) => {
        extension.addBeforeCommandHook(cmd, () => {
          void (async () => {
            if ((await isHeimdallConnectionActive()) && cookieStatus().status !== 'ok') {
              await runCookieRefresh();
            }
          })();
        });
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
