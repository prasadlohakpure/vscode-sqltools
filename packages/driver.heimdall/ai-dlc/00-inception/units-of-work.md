# Inception — units of work

Four bolts, all independent, all fanned out in parallel. Independence is
enforced by **disjoint file ownership**, mirroring how this project split
earlier UoWs (`src/heimdall/`, `src/explorer/`, `src/results/`).

## File ownership map

Two files are wanted by more than one bolt, so the orchestrator wrote them
**before** the fan-out and no bolt may edit them:

| File | Owner | Why pre-wired |
|---|---|---|
| `package.json` | orchestrator (done) | UoW-01 needs `contributes.commands`/`keybindings`; UoW-03 needs a `test` script. Both would have written the same file. |
| `src/ipc.ts` | orchestrator (done) | The ext↔LS method names are the only thing UoW-01 and UoW-02 share. Written as a stable seam both import and neither edits. |

| Bolt | Owned files (exclusive write access) |
|---|---|
| UoW-01 | `src/extension.ts`, `src/gate.ts` (new) |
| UoW-02 | `src/ls/driver.ts`, `src/ls/plugin.ts`, `src/explorer/*` |
| UoW-03 | `test/**` (new dir) |
| UoW-04 | `README.md` (new), `../../scripts/install-heimdall.sh` (new), `ai-dlc/02-operations/*` |

No bolt runs `git add -A` or `git commit`. The orchestrator commits once, at
the end, after all four report.

---

## UoW-01 — Pre-execute safety confirmation gate  ⚠️ HIGHEST PRIORITY

**Story:** US-1 (FR-1). Closes the one genuine safety *regression* versus the
reference extension.

**Owner:** sub-agent (extension-host side).

**Problem.** `AbstractDriver.query()` is the only entry point and there is no
veto hook before it (verified against `packages/base-driver`,
`packages/language-server`, `packages/plugins`, `packages/extension`).
`ext_executeQuery` in `packages/plugins/connection-manager/extension.ts` goes
straight from "decide to run" to `_runConnectionCommandWithArgs('query')`. So a
`DROP TABLE` currently executes and *then* gets a warning attached.

**Approach.** A command-layer wrapper in `src/extension.ts`: register
`sqltools-driver-heimdall.executeQuery` / `.executeCurrentQuery`, read the
statement from the active editor, run `isReadOnly()` from
`src/heimdall/safety.ts` (pure — imports fine on the extension host), show a
modal confirmation when it fails, and only then delegate to the native
`sqltools.executeQuery` / `sqltools.executeCurrentQuery`.

**Acceptance criteria**
- Non-read-only statement → modal confirm before anything is submitted;
  declining submits nothing.
- Read-only statement → zero added friction, straight passthrough.
- Multi-statement selection → gate fires if *any* statement is non-read-only.
- Commands appear under the `Heimdall` category in the palette.
- Gate only applies to Heimdall connections — it must not interfere with a
  user's Postgres/SQLite connections in the same window.
- `ponytail:` comment recording the **ceiling**: two extensions contributing
  the same chord is not deterministic in VS Code, so the guarded command is
  only guaranteed on the no-selection chord (SQLTools contributes no binding
  for `executeCurrentQuery`) and via the palette. Escape hatch to document:
  setting `sqltools.disableChordKeybindings: true` deactivates SQLTools' own
  chords (all of theirs are guarded by `!config.sqltools.disableChordKeybindings`;
  ours are not), making ours win deterministically. The **upgrade path** is an
  LS→ext confirm request from inside `driver.query()`, which cannot be
  bypassed by any launch path — deferred only because `query()` is fenced as
  live-verified this pass.
- Also register the two metadata commands (`refreshMetadata`, `clearMetadata`)
  as thin `extension.client.sendRequest(...)` calls using `src/ipc.ts`'s
  constants, with a toast for the result. The LS-side handlers are UoW-02's.
  These must degrade to a clear message, not a crash, if the request rejects.

**Out of scope:** cancel-query UX. It would naturally hang off this same
command wrapper — deliberately skipped, deferred by the user.

---

## UoW-02 — Metadata cache wired under the object explorer

**Story:** US-3, US-4, US-5 (FR-3/4/5).

**Owner:** sub-agent (language-server side).

**Problem.** `explorer/metadataCache.ts`'s TTL store and
`explorer/queries.ts`'s Kyuubi builders both exist but nothing calls them:
`getChildrenForItem` is still `AbstractDriver`'s default, which resolves `[]`.
Per `src/explorer/NOTES.md`, `sqltools.refreshTree` is a bare re-render with no
cache underneath it, so without ours, every expand/collapse/re-expand is a
fresh multi-second Kyuubi job.

**Approach.** Add a `getChildrenForItem` override to `src/ls/driver.ts` —
**additive only**, do not touch `open`/`close`/`testConnection`/`query`
bodies. Serve databases/tables from the cache; fall back to a live fetch of
just the requested node when absent. Register the `REFRESH_METADATA` /
`CLEAR_METADATA` handlers in `src/ls/plugin.ts` (whose `register(server)` is
where a `server` reference is available for `onRequest`).

**Key design call (made, not to be re-litigated):** the *expand* path must be
lazy per node — one `SHOW TABLES IN <ns>` for the namespace being opened. Do
**not** call `MetadataCacheStore.refresh()` there: it crawls every namespace
(up to `DEFAULT_MAX_NAMESPACES` = 500), which at seconds-per-Kyuubi-job would
make the first expand unusable. The full crawl is exactly right for the
explicit, user-initiated `refreshMetadata` command, and that is where it goes.
`readCache()`/`writeCache()` are already public, so the lazy per-namespace fill
needs no new API on the store.

**Storage:** `MemoryCacheStorage` (already in the file). The driver has no
`globalStorageUri`; in-process caching already removes the per-expand cost
within a session. `ponytail:` the lack of cross-restart persistence.

**Acceptance criteria**
- Tree shows databases → `Tables` group → tables → `Columns` group → columns.
- Second expand of the same node issues no Heimdall job.
- First expand of an un-fetched namespace issues exactly one job.
- Columns come from a live `DESCRIBE` (the cache format stores no columns) —
  `ponytail:` that ceiling.
- `refreshMetadata` forces a full re-crawl irrespective of TTL and returns
  counts, including `staleNamespaces`, per `MetadataRequestResult`.
- `clearMetadata` empties the cache; next expand re-fetches.
- Result-shape parsing stays defensive — `columnValues` already tolerates `{}`
  vs `{columns:[],data:[]}`; keep that trust boundary intact.
- Update `src/explorer/NOTES.md`'s open questions to reflect what got wired.

---

## UoW-03 — Port the pure-module test suite

**Story:** US-6 (FR-6).

**Owner:** sub-agent.

**Problem.** Nothing under `packages/driver.heimdall/src/**` has a single test,
while the reference extension has full `node --test` coverage for every module
these were ported from.

**Approach.** Port, don't rewrite. The reference tests were written against
identical source, so the diff is mostly the header: `require('node:assert/strict')`
→ `import assert from 'assert'`, `const { test } = require('node:test')` → drop
it (jest provides `test` globally, and the `test(name, fn)` signature is
identical), `require('../src/safety.ts')` → `import { ... } from '../src/heimdall/safety'`.

**Runner:** the workspace's existing jest + ts-jest. Verified working before
fan-out: a `.test.ts` under `packages/driver.heimdall/test/` is picked up by
the root `jest.config.js` and passes. Invoke via
`yarn workspace sqltools-driver-heimdall run test` (script pre-wired).
Do not add a second runner (NFR-4).

**Source files to port from** `/Users/prasad.lohakpure/go_path/src/patterninc/heimdall-vs-code-ext/test/`:
`safety.test.js`, `targets.test.js`, `heimdall-client.test.js`,
`auth.test.js`, `metadata-cache.test.js`.

**Acceptance criteria**
- Tests for `heimdall/{safety,targets,client,auth}.ts` and
  `explorer/metadataCache.ts`.
- All green under the workspace jest.
- Cover only the **currently exported** surface of `metadataCache.ts`
  (`readCache`/`writeCache`/`status`/`isRefreshDue`/`refresh`/`columnValues`/
  `columnIndex`/`formatAge`) — UoW-02 is additive on that file in parallel.
- No `node:` imports (NFR-1). No network in tests — stub `fetch`/the HTTP layer
  the way the reference client tests already do.
- Where a reference test covers behaviour that genuinely does not exist in the
  fork, say so in the bolt doc rather than inventing a test.

---

## UoW-04 — Rollout and packaging plan

**Story:** US-7 (FR-7).

**Owner:** sub-agent. Docs and one script — no source changes.

**Problem.** Both extensions are `private: true`, `-SNAPSHOT`, hand-installed
by `.vsix` on exactly one machine. Mixing a marketplace core with a
fork-built driver is a real, already-hit hazard, so core and driver must be
installed as a **version-matched pair**.

**Acceptance criteria**
- `ai-dlc/02-operations/rollout-plan.md`: how this reaches the team, the exact
  `--install-extension` invocations for the matched pair, the
  marketplace-core/fork-driver mismatch hazard called out, rollback (reinstall
  upstream SQLTools, uninstall the driver), and a written definition of "done"
  short of marketplace publishing.
- `ai-dlc/02-operations/monitoring-plan.md`: for a local editor extension —
  what a user should check when it misbehaves (SQLTools output channel, driver
  `messages` warnings, Gatekeeper cookie age vs `COOKIE_MAX_AGE_DAYS`), and
  which failures should route back into `units-of-work.md`.
- `../../scripts/install-heimdall.sh`: builds/locates both `.vsix` files and
  installs them into `code` or `cursor`, failing loudly on a version mismatch
  between core and driver.
- `packages/driver.heimdall/README.md`: goal paragraph, prerequisites
  (Gatekeeper cookie file / `PATTERN__HEIMDALL_TOKEN` — **names only, never
  values**), install commands, the FR-1 keybinding caveat from UoW-01, known
  limitations pointing at the `ponytail:` markers.
- A paragraph and a script. Not a CI/CD pipeline.

---

## Deferred this pass (recorded, not built)

| Item | Reason |
|---|---|
| **Cancel-query UX** | Explicitly deferred by the user. Not built, not stubbed. |
| **FR-2 loud mismatch toast** | Needs an LS→ext notification from inside `driver.query()`, whose body is fenced as live-verified this pass. The mismatch is already in `messages`; the seam (`src/ipc.ts`) is in place for a one-line follow-up once `query()` is unfenced. |
| `filterObjects` | Dead. VS Code's native `list.find` covers it. No replacement. |
| `searchColumns` multi-table | Not cheap: Spark's `DESCRIBE` is not a subquery-able relation, so `UNION ALL` of `DESCRIBE` is invalid SQL. Existing `ponytail:` comment is the honest state. |
| Real Heimdall icons | No reusable Pattern/Heimdall raster/vector asset in either repo (checked). Commissioning art is out of scope. |
| On-disk metadata persistence | No `globalStorageUri` for the driver; in-session caching captures most of the win. |
| Marketplace publishing | Internal tool; both packages stay `private: true`. |
