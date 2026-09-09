# Inception — user stories

Persona throughout: a Pattern data analyst or data engineer who already lives
in VS Code / Cursor and runs Spark SQL against the lake through Heimdall.

## US-1 — Don't let me drop a table by muscle memory (FR-1)

> As an analyst with a `DELETE FROM ...` still selected in my scratch file,
> when I hit the run chord, I want to be asked "this isn't read-only — run
> anyway?" before anything is submitted, so a stray keystroke can't mutate the
> lake.

Acceptance:
- A statement `isReadOnly()` rejects triggers a modal confirmation **before**
  any job is submitted to Heimdall.
- Declining submits nothing at all.
- Accepting runs it exactly as before, including the existing after-the-fact
  `messages` warning.
- A read-only statement (`SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN`/`WITH`) is never
  interrupted — zero added friction on the 99% path.

## US-2 — Tell me loudly if my query went somewhere else (FR-2)

> As an engineer who deliberately picked `spark-eks`, if Heimdall actually ran
> my job on a different cluster, I want a notification I can't scroll past, not
> a line in the results grid.

Acceptance:
- A `mismatch` verification state raises a visible error notification.
- The merely-`unverified` state stays `messages`-only (matches the reference
  extension's own choice — don't cry wolf on "couldn't confirm").

## US-3 — Make the object explorer usable (FR-3)

> As an analyst browsing the catalog, I want expanding a database to be
> instant the second time, so I can explore the lake without paying a
> multi-second Kyuubi job per click.

Acceptance:
- The SQLTools connection explorer shows databases → tables → columns for a
  Heimdall connection.
- Re-expanding a node already fetched in this session issues **no** Heimdall
  job.
- `sqltools.refreshTree` re-renders from cache instantly rather than
  re-crawling.
- A first expand of an un-fetched node fetches just that node — not a
  full-catalog crawl. (One query, not 500.)

## US-4 — Let me force a refresh when the catalog changed (FR-4)

> As an engineer who just created a table, I want to force the cache to
> re-crawl so my new table shows up without restarting the editor.

Acceptance:
- A command-palette entry re-crawls regardless of TTL staleness.
- It reports what it found (namespace/table counts, and any namespaces it
  couldn't refresh).
- The tree reflects the new data afterwards.

## US-5 — Let me throw the cache away (FR-5)

> As an engineer who just changed the catalog setting, I want to empty the
> cache so nothing stale can be served.

Acceptance:
- A command-palette entry empties the cache.
- The next expand does a fresh fetch.

## US-6 — Don't let the ported logic rot (FR-6)

> As the next person to touch this package, I want the pure modules covered by
> tests, the way they were in the extension this came from, so a refactor
> can't silently break auth resolution or the safety rails.

Acceptance:
- `heimdall/{safety,targets,client,auth}.ts` and `explorer/metadataCache.ts`
  have tests.
- Tests run on the workspace's existing jest + ts-jest — no second runner.
- The reference repo's existing tests are **ported**, not rewritten from
  scratch, wherever the source is identical.

## US-7 — Let my teammates install this (FR-7)

> As a teammate, I want one command to install the matched core+driver pair,
> so I don't have to reverse-engineer two `.vsix` paths from a Slack thread.

Acceptance:
- A documented install path with the exact commands.
- A script that does it, checked in.
- A written definition of "done" short of marketplace publishing.

## Deferred (recorded, not built)

- **US-X — cancel a running query.** Explicitly deferred by the user. Would
  naturally attach to US-1's command wrapper; noted there and skipped.
