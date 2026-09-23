# Inception round 2 — units of work

Follow-up round after UoW-01..05 (driver.heimdall) and the initial
sqltools-charts build. Same discipline as round 1: disjoint file ownership,
pre-wired shared files before fan-out, no bolt runs `git add`/`git commit`.

## Decision: grid features build inside our own panel, not core

The requested grid feature list (Sort Ascending/Descending, Select Column,
Pin Column submenu, Wrap Column Text, Format, Autosize This/All Columns,
Group by, Choose Columns, Reset Columns, Copy Name) is SQLTools' native
results grid rebuilt as if it were AG-Grid's enterprise column menu — but
SQLTools core's actual results grid is `@devexpress/dx-react-grid`
(`packages/plugins/connection-manager/webview/ui/screens/Results/components/Table`),
not AG-Grid. Extending that is a real, ongoing-merge-conflict fork of core
UI — decided (explicit user choice) to instead build this into
`sqltools-charts`' own "Open Result" webview, which only this extension
owns. Chosen library: **Tabulator (MIT, `tabulator-tables`)** — its built-in
sort/frozen-columns/resizable-columns/groupBy/movable-columns cover nearly
the whole list natively; `headerMenu`/`headerContextMenu` covers the rest
(Choose Columns, Reset Columns, Copy Name) without hand-rolling a menu.

## Pre-wired before fan-out (done, do not re-edit)

- `packages/sqltools-charts/package.json`: `tabulator-tables` dependency,
  `output-webview` compile/watch/build scripts (glob-picked-up by the
  existing `npm:build:*`/`npm:watch:*` concurrently patterns), new
  `viewsContainers.panel` entry (`sqltoolsChartsPanelContainer`) with Query
  Output moved into it (was in the sidebar activity bar container), new
  File Bookmarks view + 4 new commands (`bookmarkFile`,
  `openFileBookmark`, `removeFileBookmark`, `clearFileBookmarks`) and their
  menu contributions.
- `packages/driver.heimdall/package.json`: new command
  `sqltools-driver-heimdall.refreshCookie` ("Refresh Gatekeeper Cookie").
- `packages/driver.heimdall/src/heimdall/auth.ts`: `REFRESH_CMD` (`mise run
  agent-sandbox:auth`) changed from private to exported — the cookie-refresh
  bolt needs the exact string, not a duplicate.

## UoW-06 — Rich result grid (Tabulator) in the Query Output panel

**Owner:** sub-agent. **Files (exclusive):**
`packages/sqltools-charts/src/output/webview.ts`,
`packages/sqltools-charts/src/output/webview-entry.ts` (new).

Replace the plain `<table>` in `showResult()` with a Tabulator instance,
built the same way `chart/index.ts` + `chart/webview-entry.ts` already do it
for the chart panel (`webview-entry.ts` is the client-side bundle compiled
to `out/output-webview.js` via esbuild, inlined as a `<script>` tag —
mirror that structure exactly, including passing data via
`window.__RESULT_DATA__` the way chart uses `window.__CHART_DATA__`).

Cover, via Tabulator's real feature set (do not hand-roll anything Tabulator
already does):
- Sort Ascending / Sort Descending — Tabulator's built-in column sort
  (`headerSort: true`, click header).
- Select Column — a `headerMenu` entry per column (Tabulator's
  `column.definition.headerMenu` API) toggling that column's selection
  highlight, or simplest-correct: reuse Tabulator's native row/cell
  selection if a column-level equivalent isn't worth hand-building — your
  call, document whichever you pick and why in a short comment.
- Pin Column → submenu (left / right / none) — Tabulator's `column.frozen`
  (freeze left) plus its RTL/right variant if the version installed
  supports it; if only one direction is supported by this Tabulator
  version, ship that one and note the ceiling rather than half-implementing
  a fake submenu.
- Wrap Column Text — toggle a CSS class controlling `white-space` on that
  column's cells via Tabulator's per-column `formatter`/`cssClass`.
- Format — a small menu of obvious formatters (number with commas, date,
  plain text) applied via Tabulator's `formatter` option; don't invent a
  format string DSL, three or four canned formats is enough for this pass.
- Autosize This Column / Autosize All Columns — Tabulator's built-in
  `table.setColumnWidth(true)` / a per-column autosize call it already
  exposes.
- Group by `<column>` — Tabulator's `setGroupBy`.
- Choose Columns — a header-menu-driven show/hide toggle using Tabulator's
  `column.hide()`/`.show()`.
- Reset Columns — clear grouping/hidden/frozen/sort state back to the
  as-loaded default.
- Copy Name — copies the clicked column's header name to the clipboard
  (`navigator.clipboard.writeText` works inside a VS Code webview with
  `enableScripts: true`; no extra permission needed).

Keep the query/row-count header line already in `showResult()`. Keep the
error-state branch (query failed) exactly as-is — Tabulator only replaces
the success-path table.

**Verify:** `yarn workspace sqltools-charts run test:tsc`, then
`yarn workspace sqltools-charts run build` — confirm
`out/output-webview.js` is produced and its size reflects Tabulator being
bundled (expect a real jump from near-zero, Tabulator is not tiny — that's
expected, not a bug). Grep the bundle for a Tabulator signature (e.g. its
own version string or a distinctive class name) the same way the chart
bundle was checked for Chart.js earlier this project.

## UoW-07 — File bookmarks (bookmark a file, not just a query)

**Owner:** sub-agent. **Files (exclusive, new):**
`packages/sqltools-charts/src/filebookmarks/index.ts`,
`packages/sqltools-charts/src/filebookmarks/tree-items.ts`.
**Files (exclusive, edit):** `packages/sqltools-charts/src/extension.ts`
(register the 4 pre-wired commands + the new tree view — additive only,
do not touch the existing capture/output/chart registrations already
there).

SQLTools' own `bookmarks-manager` (core) stores extracted query TEXT, not a
file reference — reading it again later shows a frozen snapshot, not the
live file. This is a distinct, complementary feature: bookmark a FILE path
(any extension — `.sql`, `.txt`, whatever's open), so opening it always
shows current content.

- `bookmarkFile`: bookmark `window.activeTextEditor.document.uri.fsPath`.
  No-op with an info message if no editor is active. De-dupe by path (same
  file bookmarked twice updates rather than duplicates).
- Persist via `ExtensionContext.globalState` (survives restarts; a plain
  array of `{ path: string, addedAt: number }` is enough — no need for
  workspace-scoping unless you have a concrete reason to add it).
- Tree view (`sqltoolsChartsViewFileBookmarks`, already contributed):
  newest-first, label = basename, description = relative-to-workspace path
  if inside a workspace folder else the absolute path, tooltip = full path.
  Missing/deleted file on disk: show it struck-through or with a warning
  icon rather than silently failing when clicked — check existence
  (`fs.existsSync` is fine here, this is a small sidebar list, not a hot
  path) before wiring the open command, and show a clear "file no longer
  exists, remove this bookmark?" message if it's gone.
- `openFileBookmark` (tree item's default click command): opens the file in
  the editor (`workspace.openTextDocument` + `window.showTextDocument`).
- `removeFileBookmark`: removes one entry (context-menu, already wired to
  `viewItem == filebookmark.item` — set that `contextValue` on your tree
  item class).
- `clearFileBookmarks`: empties the whole list.

**Verify:** `yarn workspace sqltools-charts run test:tsc`, then
`yarn workspace sqltools-charts run build`. Confirm
`grep -in heimdall packages/sqltools-charts/src` stays empty — this package
is driver-agnostic, a file bookmark has nothing to do with which SQL driver
is active.

## UoW-08 — Auto-run cookie-monster when the Gatekeeper cookie is stale/missing

**Owner:** sub-agent. **Files (exclusive):**
`packages/driver.heimdall/src/extension.ts` (additive — do not touch the
existing gate/metadata-command/mismatch-notification registrations already
there).

**Problem.** `heimdall/auth.ts`'s `buildAuth()` (in `ls/driver.ts`, the
language server side) already detects a stale (`age > COOKIE_MAX_AGE_DAYS`,
7 days) or missing cookie file and throws a clear error naming the fix
(`mise run agent-sandbox:auth` in the data-airflow repo) — but that error
only surfaces as a failed-connection message. Nothing offers to actually
run the refresh. `buildAuth()` itself runs in the language server process,
which has no `vscode` UI access, so the fix belongs on the extension-host
side (`extension.ts`, which already has `window`/`commands`).

**Approach.**
- On activation (and via the new `refreshCookie` command, already
  pre-wired), check cookie freshness using `heimdall/auth.ts`'s exported
  `cookieFileCandidates()`, `cookieAgeDays()`, `COOKIE_MAX_AGE_DAYS`, and
  `REFRESH_CMD` (now exported — see pre-wiring note above). Read the first
  candidate file that exists (mirror `buildAuth()`'s own lookup order, don't
  reinvent it), parse `when_created`, compute age.
- If stale or no cookie file exists at all: `window.showWarningMessage`
  with an action button (e.g. "Refresh now"). On click, find or ask for the
  `data-airflow` repo path (check a few sibling-directory conventions
  first — e.g. next to this workspace's own root, since this project and
  `data-airflow` are siblings under the same parent in this environment —
  but do NOT hardcode a path specific to one machine; fall back to
  `window.showOpenDialog` asking the user to locate the `data-airflow`
  checkout the first time, and remember the chosen path in
  `ExtensionContext.globalState` so it's asked at most once per machine).
- Run `REFRESH_CMD` in a **visible** VS Code integrated terminal
  (`window.createTerminal` + `.show()` + `.sendText()`), not a hidden
  child_process — cookie-monster opens a browser and may need an MFA tap,
  per `auth.ts`'s own existing `authFixes()` comment about remote
  workspaces; hiding that from the user would strand them mid-auth with no
  visible prompt.
- After sending the command, do not try to detect completion automatically
  (no reliable signal without parsing terminal output, which is fragile) —
  show an info message telling the user to retry connecting once the
  browser flow completes, and leave it at that. Simpler and honest > a
  fragile completion-polling loop.
- Skip the activation-time check entirely (no warning, no prompt) when
  `authMode` isn't in use / no Heimdall connection exists yet in this
  window — don't nag a user who hasn't set one up.

**Verify:** `yarn workspace sqltools-driver-heimdall run test:tsc`, then
`yarn workspace sqltools-driver-heimdall run build`. This package's
existing 76 tests must still pass
(`npx jest packages/driver.heimdall` or `bash scripts/driver-verify.sh`
from the repo root) — you are not touching anything they cover, but prove
it rather than assume it.

## UoW-09 — Fresh DBCode / SQLTools feature-gap re-check

**Owner:** sub-agent, research only — no source changes, one doc.
**Files (exclusive, new):**
`packages/sqltools-charts/ai-dlc/00-inception/gap-analysis-round2.md`.

The original DBCode/SQLTools comparison happened before `driver.heimdall`
and `sqltools-charts` existed. Re-run it now that both exist: for each of
DBCode's advertised features (charts ✓ now covered, SQL notebooks, ER
diagrams, data editing, AI/MCP tools, secure report sharing, autocomplete,
SQL formatter, CSV/JSON export, saved queries/bookmarks, query history with
duration/status — note which of these `sqltools-charts` + core SQLTools +
`bookmarks-manager`/`history-manager` now already cover) and for SQLTools
core's own feature set, produce a short table: feature / status
(have it / gap / deliberately out of scope, with the existing reason if
one was already recorded) / rough effort if it's a real gap. Do not
re-litigate decisions already made and recorded (e.g. ER diagrams,
notebooks, marketplace publishing are already recorded as deliberately
skipped in `driver.heimdall`'s own `units-of-work.md` — cite that instead
of re-deciding). Flag anything genuinely new and cheap, if there is any.

## Explicitly out of scope this round

- Extending core SQLTools' DevExpress results grid directly — decided
  against (see decision note above).
- Cancel-query UX — still on hold, unrelated to this round, don't touch.
