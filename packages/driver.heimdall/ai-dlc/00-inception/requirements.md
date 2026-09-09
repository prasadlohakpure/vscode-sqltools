# Inception — requirements

Project: `packages/driver.heimdall` in the Pattern fork of `mtxr/vscode-sqltools`
(remote `prasadlohakpure/vscode-sqltools`, branch `dev`).

Date: 2026-09-09. Run as a single autonomous Inception pass — no
requirements-gathering conversation; everything below was already established
in the originating thread and is recorded here as the confirmed baseline.

## Goal

Replace the bespoke `heimdall-vs-code-ext` VS Code extension with a SQLTools
**driver**, so Pattern analysts get a real SQL IDE (editor, results grid,
history, bookmarks, object explorer, multi-connection management) for Heimdall
Spark SQL instead of a hand-rolled webview, and we stop maintaining the parts
SQLTools already owns.

## Context: what "ported" means here

The reference extension owned the whole UX. The driver owns only the parts
SQLTools delegates. Three consequences drive every requirement below:

1. **Pure Heimdall logic ports verbatim** — `client.ts`, `targets.ts`,
   `safety.ts`, `auth.ts` are `vscode`-free and moved unchanged.
2. **UI-owning code has no destination** — the results webview, the custom
   sidebar tree, and the query-history store are SQLTools features now.
3. **Some UX has no hook to port to.** SQLTools' driver contract
   (`AbstractDriver`) exposes `open`/`close`/`testConnection`/`query`/
   `getChildrenForItem` and nothing before execution. Anything the reference
   extension did *before* submitting a job has to be re-homed on the
   extension-host side or lost. This is the source of the single highest-risk
   requirement (FR-1).

## Baseline: already built and verified against live credentials

- `src/heimdall/{client,targets,safety,auth}.ts` — ported, pure.
- `src/ls/driver.ts` — `open`/`close`/`testConnection`/`query` wired, including
  safety-rail warnings and target-mismatch verification surfaced through
  `NSDatabase.IResult.messages`.
- `src/results/annotate.ts` — packs warnings into the native result grid.
- `src/explorer/{queries,metadataCache}.ts` — built, **not wired**.
- `connection.schema.json` / `ui.schema.json` — conditional auth form
  (`cookie-file` auto-reads the Gatekeeper file; `service-token` falls back to
  `PATTERN__HEIMDALL_TOKEN`).
- Verified end to end: auth resolves, `/commands` and `/clusters` return real
  data, both `kyuubi` and `spark-eks` resolve to exactly one command/cluster
  pair. Matched core + driver `.vsix` pair installed in Cursor.

**Frozen surface.** `open`/`close`/`testConnection`/`query` in
`src/ls/driver.ts` and both schema JSON files are live-verified and must not
regress. The only permitted change to that file this pass is *adding*
`getChildrenForItem`.

## Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | A non-read-only statement must not reach Heimdall without an explicit user confirmation. Today it runs immediately with only an after-the-fact warning — a **safety regression** vs. the reference extension. | **Highest** |
| FR-2 | A real target-mismatch (Heimdall ran the job somewhere other than the picked target) must be surfaced loudly, not only inline in the results grid. | High |
| FR-3 | Object-explorer tree expansion must be served from a cache, not a fresh Kyuubi job per expand. Neither Heimdall connector is `is_sync`, so every catalog query is a submit→poll→fetch cycle costing seconds, and SQLTools core caches nothing under `getChildrenForItem`. | High |
| FR-4 | The user must be able to force a metadata re-crawl regardless of TTL staleness. | Medium |
| FR-5 | The user must be able to empty the metadata cache, so the next expand re-crawls. | Medium |
| FR-6 | The pure modules must have automated test coverage at parity with the reference extension, which has full `node --test` coverage for every module they were ported from. | Medium |
| FR-7 | The team must be able to install the matched core+driver pair without hand-typing `.vsix` paths. | Medium |

## Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | No `node:`-prefixed built-in imports anywhere in this package. This fork pins `@types/node` 14.6.0, which cannot resolve them. Bare specifiers only (`fs`, `os`, `path`). |
| NFR-2 | Comment density matches the existing house style — header comments explaining *why*, not just *what*. See `heimdall/targets.ts`, `heimdall/safety.ts`, `explorer/queries.ts`. Do not strip this down. |
| NFR-3 | Every deliberate shortcut with a known ceiling carries a `ponytail:` comment naming the ceiling and the upgrade path. |
| NFR-4 | One test runner only. The workspace already has jest + ts-jest at the repo root (`jest.config.js`, `testMatch: ['**/*.test.(ts)']`). Do not introduce a second. |
| NFR-5 | Every unit of work runs `yarn workspace sqltools-driver-heimdall run test:tsc` **and** `... run build` before reporting done. `tsc --noEmit` alone is insufficient — the esbuild bundle step has caught real issues in this project. |
| NFR-6 | No real secrets or credentials in any planning doc or committed file. Reference where they live (`~/.pattern/gatekeeper/heimdall.json`, `PATTERN__HEIMDALL_TOKEN`). |

## Out of scope this pass

| Item | Why |
|---|---|
| **Cancel-query UX** ("cancel everywhere") | Explicitly deferred by the user earlier in this project. Not built, not stubbed. If a unit of work wants a cancel button, it is noted as future scope and skipped. |
| `filterObjects` command | Confirmed dead. VS Code's native `list.find` (Ctrl/Cmd+F on any focused tree) already covers it, and SQLTools' explorer is a plain `TreeView`. See `src/explorer/NOTES.md`. No replacement needed. |
| `searchColumns` multi-table search | Already `ponytail:`-marked as first-table-only. Not cheap to fix: Spark's `DESCRIBE` is not a subquery-able relation, so the "obvious" `UNION ALL` of `DESCRIBE` per table is not valid Spark SQL. The honest existing comment stays. |
| Real Heimdall icons | `icons/{active,default,inactive}.png` are `driver.sqlite` placeholders. Neither repo contains a reusable Pattern/Heimdall logo asset (checked), and commissioning art is out of scope. Deferred. |
| Publishing to the public VS Code marketplace | Internal Pattern tool. Both packages stay `private: true`. |
| On-disk metadata cache persistence | The driver has no `globalStorageUri` of its own. In-process caching already removes the per-expand Kyuubi cost within a session; persistence across restarts is a separate, smaller win. |

## Key architectural finding (drives FR-1's design)

`AbstractDriver.query()` is the only execution entry point a driver implements.
There is no `beforeExecute`/`willRunQuery` veto hook anywhere in
`packages/base-driver`, `packages/language-server`, `packages/plugins`, or
`packages/extension` — verified by reading
`packages/plugins/connection-manager/extension.ts`'s `ext_executeQuery`, which
goes straight from "decide to run" to `_runConnectionCommandWithArgs('query')`
with no confirmation step.

So FR-1 cannot be satisfied inside the driver. It has to be a command-layer
wrapper on the extension-host side: our own command that runs `isReadOnly()`
against the statement, confirms, and only then delegates to SQLTools' native
command. That wrapper's reach is bounded by keybinding precedence — see
`units-of-work.md` UoW-1 for the resulting ceiling and the escape hatch.
