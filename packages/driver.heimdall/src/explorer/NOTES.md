# Object explorer: retired Heimdall commands vs SQLTools core

Verified against `packages/extension/package.json` (menus/commands) and
`packages/plugins/connection-manager/extension.ts` in this repo.

## `heimdall.filterObjects` -> **dead code**

- SQLTools contributes no filter/search box of its own on the connection
  explorer tree — grepped `packages/extension/src` and
  `packages/plugins/connection-manager/extension.ts` for `filter`/`QuickPick`/
  `list.find`: nothing wired to the tree view itself (the few `QuickPickItem`
  hits are unrelated connection pickers).
- Same as the old extension's own `heimdall.filterObjects` comment already
  concluded for its tree: VS Code's built-in `list.find` (Ctrl/Cmd+F on a
  focused list/tree) works on *any* extension-contributed `TreeView` with the
  default `keyboardNavigationLabelProvider`, no per-extension opt-in needed.
  SQLTools's tree is a plain `TreeView`, so it already gets this for free.
- Conclusion: **fully redundant, drop it.** No equivalent command needed —
  not even the thin focus-and-invoke wrapper the old extension kept, since
  there's no `OBJECT_EXPLORER_VIEW_ID` of our own to focus; the connection
  explorer is SQLTools's tree, and its find widget is discoverable the same
  Ctrl+F way.

## `heimdall.refreshMetadataCache` -> **thin command still needed, real porting work underneath**

- SQLTools does have a native per-connection refresh: `sqltools.refreshTree`
  (toolbar button, `view/title` and `view/item/context` menu entries in
  `packages/extension/package.json`). It calls `explorer.refresh()`
  (`packages/plugins/connection-manager/extension.ts:45`), which fires
  `onDidChangeTreeData` and makes VS Code re-call `getChildrenForItem` for
  the expanded nodes.
- Critically, **that re-call goes straight to the driver's `getChildrenForItem`
  every time** — SQLTools core has no TTL/result cache of its own for
  connection-explorer children. For a live JDBC/sqlite driver that's fine
  (a `SELECT` is milliseconds). For Heimdall/Kyuubi it is not: per this
  driver's own `metadata-cache.ts` source comments, neither connector is
  `is_sync`, so every query is a submit -> poll -> fetch cycle costing
  seconds. Without our own cache, `sqltools.refreshTree` — or even just
  expanding/collapsing/re-expanding a namespace — would hammer Heimdall on
  every click.
- Conclusion: **the TTL cache (`metadataCache.ts`) is still fully needed**,
  just relocated: it now sits *underneath* `getChildrenForItem` (serving
  cached namespaces/tables so expansion is instant) instead of behind a
  custom tree provider. `sqltools.refreshTree`'s native button is the right
  *trigger* UI (no need to reinvent it), but it needs to be backed by a
  command that actually re-crawls Kyuubi and repopulates our cache before
  SQLTools re-queries — otherwise "refresh" just re-reads the same stale
  cache instantly and looks like a no-op.
- So: keep a `heimdall`-side refresh command (or hook `sqltools.refreshTree`
  via `explorer.refresh` if this driver can register a pre-refresh hook —
  needs checking against `src/ls/driver.ts`/`src/ls/plugin.ts`, which is the
  scaffolding agent's file, not mine) that calls
  `MetadataCacheStore.refresh()` per target, then lets SQLTools's native
  refresh re-render from the now-fresh cache. This is real porting work, not
  a freebie.

## `heimdall.clearMetadataCache` -> **thin command still needed, trivial to keep**

- SQLTools has no concept of "our" metadata cache at all — nothing to clear
  on its side, no native equivalent, because SQLTools doesn't know one
  exists (it just calls `getChildrenForItem`).
- Conclusion: **keep a thin command** that calls
  `MetadataCacheStore.writeCache({ version, targets: {} })` (already ported,
  unchanged) followed by whatever triggers a UI refresh (`sqltools.refreshTree`
  or the driver's own tree invalidation). Small, but not deletable — it's the
  only way to force-invalidate a target whose cache holds wrong data (e.g.
  after a `catalog` setting change) without waiting out the TTL.

## Summary

| Command | Status | Why |
|---|---|---|
| `heimdall.filterObjects` | **Dead** — delete, no replacement | VS Code's native `list.find` already covers it on any tree, SQLTools's included |
| `heimdall.refreshMetadataCache` | **Needs a thin command wired to real porting work** | SQLTools's `sqltools.refreshTree` is only a re-render trigger with no cache of its own; our TTL crawl (`metadataCache.ts`) must still run underneath it or every refresh (and every raw expand) re-hits slow Kyuubi jobs |
| `heimdall.clearMetadataCache` | **Needs a thin command, logic already ported** | SQLTools has no cache to clear; ours is invisible to it and needs its own invalidation entry point |

## UoW-02 update: wired (this pass)

Everything above this section was written before `getChildrenForItem` existed.
It's now implemented in `src/ls/driver.ts`, additive-only alongside the
already-verified `open`/`close`/`testConnection`/`query`. What changed:

- **Tree shape**: `CONNECTION` -> `DATABASE` (one per Spark namespace) ->
  `Tables` resource group -> `TABLE` -> `Columns` resource group -> `COLUMN`.
  Matches the "databases -> Tables -> tables -> Columns -> columns" shape
  called for in `units-of-work.md`.
- **Cache-backed, not custom-tree-provider-backed**, exactly as concluded
  above: `getChildrenForItem` reads/writes `MetadataCacheStore` (now backed
  by a per-driver-instance `MemoryCacheStorage`) directly via its public
  `readCache()`/`writeCache()` — no new API needed on the store, per the
  inception plan.
- **Lazy per-node expand, not a crawl**: the root's first-ever expand runs
  one `SHOW NAMESPACES IN glue_catalog` job to learn namespace names (nothing
  else — no per-namespace `SHOW TABLES` yet). Expanding one namespace's
  `Tables` group runs one `SHOW TABLES IN glue_catalog.<ns>` job only if that
  namespace isn't already cached; a second expand of the same namespace is a
  cache hit, zero jobs. `MetadataCacheStore.refresh()` (the full crawl of
  every namespace) is never called from the expand path — only from the new
  `refreshMetadata()` method, which is what the `refreshMetadataCache`
  command above now resolves to.
- **`heimdall.refreshMetadataCache` / `heimdall.clearMetadataCache`**: both
  now have real handlers. `HeimdallDriver.refreshMetadata()` runs
  `MetadataCacheStore.refresh('kyuubi', ...)` irrespective of TTL and returns
  a `MetadataRequestResult` message including `staleNamespaces` count.
  `HeimdallDriver.clearMetadata()` calls `writeCache({ version, targets: {} })`
  exactly as this file originally proposed. Both are registered in
  `src/ls/plugin.ts` against `../ipc.ts`'s `REFRESH_METADATA`/`CLEAR_METADATA`,
  looked up by `connId` through a small `HeimdallDriver.getInstance` registry
  (`LSContextMap.drivers` only maps driver *type* -> class, not the live
  per-connection instance — see the ponytail comment on that registry in
  `driver.ts` for its one known ceiling: no cleanup on `close()`).
- **Columns stay live**: `getColumns` always runs a fresh `DESCRIBE` through
  the existing `IBaseQueries.fetchColumns` / `this.query()` path (not the
  metadata cache, which has no column data at all — FR-5's known ceiling,
  called out again in `driver.ts`).
- **Still open**: on-disk persistence across LS/editor restarts (no
  `globalStorageUri` for this driver — unchanged from this file's original
  note), and the empty-namespace/never-fetched ambiguity noted as a
  `ponytail:` comment in `driver.ts`'s `listDatabases`.
