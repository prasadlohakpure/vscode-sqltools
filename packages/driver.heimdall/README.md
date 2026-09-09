# SQLTools Heimdall driver

A [SQLTools](https://vscode-sqltools.mteixeira.dev/) driver that routes SQL
queries through Pattern's Heimdall service instead of connecting directly to
a database. You write and run SQL in the SQLTools UI as usual; the driver
submits it to Heimdall, polls for the result, and renders it in the normal
results panel — no direct DB connection or credentials on your machine.

This is an internal Pattern tool: both this package and the forked core it
depends on are `private: true` and distributed as `.vsix` files, not
published to any Marketplace.

## Prerequisites

One of the following, for Heimdall auth (see
`src/heimdall/auth.ts`) — names only, never put a real token or cookie value
anywhere, including in chat, commit messages, or config committed to git:

- **Cookie-file mode** (default, browser-based): a Gatekeeper cookie file at
  `~/.pattern/gatekeeper/heimdall.json` or `/etc/gatekeeper/heimdall.json`.
  Refresh it with `mise run agent-sandbox:auth` in the `data-airflow` repo.
- **Service-token mode** (headless/remote-friendly): the `PATTERN__HEIMDALL_TOKEN`
  environment variable, optionally with `PATTERN__HEIMDALL_USER` set so
  queries are attributed to you instead of the bare service account.

## Install

Both the core (fork-built) and this driver must be installed together, from
the same build — see
[`ai-dlc/02-operations/rollout-plan.md`](./ai-dlc/02-operations/rollout-plan.md)
for why mixing a Marketplace core with this driver is unsafe.

```bash
bash scripts/install-heimdall.sh
```

from the repo root. It builds (or locates) both `.vsix` files, checks they
came from the same version pair, finds your `cursor`/`code` CLI, and installs
both. See the rollout plan for the manual `--install-extension` invocations
and rollback steps if you'd rather do it by hand.

## Known limitations

- **Keybinding chords are not deterministic (FR-1 / UoW-01).** VS Code does
  not guarantee which extension wins when two contribute the same chord.
  This driver's guarded `executeCurrentQuery` command is only guaranteed to
  fire via the Command Palette or the no-selection chord — SQLTools
  contributes no binding for the with-selection variant it collides with.
  To make this driver's binding win deterministically, set
  `sqltools.disableChordKeybindings: true` (SQLTools guards all of its own
  chords behind that setting; this driver's are not guarded by it). See
  `src/extension.ts`.
- **Cancel-query UX does not exist.** Deliberately deferred, not a bug — see
  `units-of-work.md`'s "Deferred this pass" table.
- **Metadata cache never cleans up on connection close.** Driver instances
  accumulate in the cache across reconnects for the life of the editor
  session (`src/ls/driver.ts`).
- **Empty vs. never-fetched namespace ambiguity.** An empty `[]` from
  `listTables`/similar doubles as "not yet fetched" — there's no separate
  "fetched and genuinely empty" state (`src/ls/driver.ts`).
- **`searchColumns` only searches one table at a time**, not across a whole
  schema — Spark's `DESCRIBE` isn't a subquery-able relation, so a
  cross-table `UNION ALL` isn't valid SQL here (`src/ls/driver.ts`).
- **Safety-gate statement splitting is regex-based, not a real SQL parser**
  — it splits on top-level `;` with no quote/comment awareness
  (`src/gate.ts`).
- Smaller documented trade-offs also live inline as `ponytail:` comments in
  `src/explorer/queries.ts`, `src/explorer/metadataCache.ts`,
  `src/heimdall/targets.ts`, `src/heimdall/client.ts`, and `src/ipc.ts` —
  grep for `ponytail:` under `src/` for the current, authoritative list.

## Monitoring / troubleshooting

See
[`ai-dlc/02-operations/monitoring-plan.md`](./ai-dlc/02-operations/monitoring-plan.md)
for what to check when something misbehaves (SQLTools Output channel,
in-result warning messages, Gatekeeper cookie age) and when a problem should
be filed as a new entry in `units-of-work.md` versus just retried.
