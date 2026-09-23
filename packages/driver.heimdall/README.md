# SQLTools Heimdall driver

A [SQLTools](https://vscode-sqltools.mteixeira.dev/) driver that routes SQL
queries through Pattern's Heimdall service instead of connecting directly to
a database. You write and run SQL in the SQLTools UI as usual; the driver
submits it to Heimdall, polls for the result, and renders it in the normal
results panel — no direct DB connection or credentials on your machine.

This is an internal Pattern tool: both this package and the forked core it
depends on are `private: true` and distributed as `.vsix` files, not
published to any Marketplace.

## Features

- **Two targets**: `kyuubi` (interactive Spark SQL) and `spark-eks` (batch,
  cold-start). Pick per connection; the driver resolves each to exactly one
  live Heimdall command+cluster pair and refuses to guess if that ever
  becomes ambiguous (`src/heimdall/targets.ts`).
- **Read-only enforcement, hard block.** Only `SELECT`/`SHOW`/`DESCRIBE`/
  `EXPLAIN`/`WITH` run. Everything else — `INSERT`/`UPDATE`/`DELETE`/DDL, or
  anything the classifier doesn't recognise — is refused before it ever
  reaches Heimdall, regardless of which SQLTools feature triggered it (typed
  and run, Run from History, Run from Bookmarks, right-click Show Records —
  all funnel through the same check). See "What actually runs" below.
- **Automatic row cap.** A plain `SELECT`/`WITH` with no `LIMIT` gets one
  appended (1000 rows) before submission — never an unbounded interactive
  query.
- **Cookie-file auth**, automatic. Reads the Gatekeeper cookie file
  (`~/.pattern/gatekeeper/heimdall.json` or `/etc/gatekeeper/heimdall.json`)
  — nothing to type into the connection form. If it's missing or stale, the
  driver runs `cookie-monster` for you in a visible terminal (opens a
  browser for Okta/MFA, which you complete yourself) — triggered on
  activation and before/around every query attempt, from whichever command
  path you use.
- **Object explorer**, cached. Databases → Tables → Columns, backed by an
  in-session TTL cache so re-expanding a node costs zero Heimdall jobs;
  `refreshMetadata`/`clearMetadata` commands force a re-crawl or empty the
  cache on demand.
- **Loud target-mismatch alert.** If Heimdall actually ran your query on a
  different command/cluster than the one you picked, you get a real error
  toast, not just a line buried in the results grid.
- **Query Output panel + charts** (`sqltools-charts`, a separate,
  driver-agnostic companion extension — works with any SQLTools driver, not
  just this one): every executed query logged with duration/status/row
  count, click through to a full result table, or chart any past result
  (Column/Bar/Line/Area/Pie/Polar/Scatter/Combination) via a config UI —
  chart type and columns are picked in the webview, no re-query needed.

## What actually runs

The SQL you write is not sent to Heimdall verbatim — three things can change
it, and one thing can stop it, before it ever leaves your editor:

1. **Read-only check.** `heimdall/safety.ts`'s `isReadOnly()` classifies the
   statement. If it fails, nothing is submitted — the result you see back is
   a local "blocked" message, not anything Heimdall returned.
2. **Row-cap injection.** A `SELECT`/`WITH` with no existing `LIMIT` anywhere
   in it gets ` LIMIT 1000` appended (after any trailing `;` or comment, so
   it's not appended into a comment or past a terminator). A statement that
   already has a `LIMIT`, or isn't a `SELECT`/`WITH` at all (e.g. `SHOW`,
   `DESCRIBE`), is sent unchanged.
3. **Job wrapping.** The (possibly LIMIT-injected) SQL is wrapped as
   `{ query: <sql>, return_result: true, ...extra }` via `sqlContext()` and
   submitted as a Heimdall job: `POST /api/v1/job` with
   `command_criteria`/`cluster_criteria` from whichever target
   (`kyuubi`/`spark-eks`) the connection is set to. The driver then polls
   `GET /job/{id}/status` until terminal and fetches `GET /job/{id}/result`
   (or reads the result inline if the submit response already carried it —
   sync commands do).
4. **Target verification.** The job's actual `command_name`/`cluster_name`
   in the response is compared against what was expected. A mismatch raises
   an error toast; nothing about the SQL itself changes at this step, it's a
   check on where it ran, not what ran.

`USE`/`SET`/`ALTER SESSION` are allowed through unmodified (they're
read-only-adjacent, not blocked) but come back with a warning that they only
affect the job that ran them — every query gets a fresh Heimdall session, so
there's no persistent session state to set for a later query to see.

## Prerequisites

A Gatekeeper cookie file at `~/.pattern/gatekeeper/heimdall.json` or
`/etc/gatekeeper/heimdall.json` — the only auth mode this driver supports.
Refresh it by running `cookie-monster` (a standalone binary on your `$PATH` —
no `mise`/`data-airflow` repo needed, despite what earlier versions of this
doc said) — or just let the driver do it, see Features above. Never put a
real cookie value anywhere, including chat, commit messages, or config
committed to git.

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

- **`Cmd+Enter`/`Ctrl+Enter` collides with `cweijan.vscode-mysql-client2`'s
  `mysql.runSQL`** if that extension is also installed — both bind the
  identical key for `.sql` files with a selection, and VS Code does not
  guarantee which one fires (effectively load-order dependent). SQLTools
  core itself contributes no `Cmd+Enter` binding, so this is a third-party
  collision, not a core one. Rebind one of the two in your own
  `keybindings.json`, or disable whichever extension isn't in use for a
  given connection, if this misfires. See `src/extension.ts`.
- **No write support, for now.** `service-token`/`PATTERN__HEIMDALL_TOKEN`
  auth and any escape hatch for non-read-only statements were both removed,
  not just hidden — see `src/ls/driver.ts`'s `buildAuth()`/`query()` header
  comments for the exact re-add path if a headless or write use case shows
  up later.
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
