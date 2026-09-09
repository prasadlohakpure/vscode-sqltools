# Monitoring plan — SQLTools Heimdall driver

**UoW-04 / US-7 (FR-7).** This is a local editor extension: no server, no
telemetry, nothing to dashboard. "Monitoring" here means: what does a user
check on their own machine when it misbehaves, and when does that turn into
a filed issue versus a retry.

## What to check, in order

1. **VS Code / Cursor Output panel → the "SQLTools" channel, specifically.**
   Output panel has a dropdown of channels; the default channel shown is
   *not* SQLTools's. Pick "SQLTools" explicitly. This is where connection
   errors, driver load failures, and language-server exceptions surface
   first — most problems show up here before anywhere else.

2. **Inline query warnings — `NSDatabase.IResult.messages`.** The driver
   attaches warnings to the results panel itself (not just the log), e.g.
   the safety-gate messages from `src/heimdall/safety.ts` and target
   validation notes from `src/heimdall/targets.ts`. If a query ran but the
   result looks wrong or incomplete, check the messages attached to that
   specific result before assuming it's a bug.

3. **Gatekeeper cookie age.** `packages/driver.heimdall/src/heimdall/auth.ts`
   defines `COOKIE_MAX_AGE_DAYS = 7`. If auth is failing (or the SQLTools
   channel shows a Gatekeeper credentials error), the cookie file is likely
   stale:
   - Cookie-file mode reads `~/.pattern/gatekeeper/heimdall.json` or
     `/etc/gatekeeper/heimdall.json`. Refresh it with `mise run
     agent-sandbox:auth` in the `data-airflow` repo.
   - Service-token mode reads `PATTERN__HEIMDALL_TOKEN` (plus optional
     `PATTERN__HEIMDALL_USER` for attribution) — check the token is still
     set and valid in the environment the editor was launched from,
     names only, never log or paste the token value itself.

4. **Extension versions.** Command Palette → "Extensions: Show Installed
   Extensions" — confirm `mtxr.sqltools` and `pattern.sqltools-driver-heimdall`
   are both installed and both came from the same fork build (see
   `rollout-plan.md`'s matched-pair rule). A mismatched pair is a common
   cause of confusing, hard-to-reproduce failures that look like driver bugs
   but aren't.

## Retry / re-auth versus file a new UoW

**Just re-authenticate or retry — don't file anything:**
- Any auth error where the cookie is older than `COOKIE_MAX_AGE_DAYS`, or
  `PATTERN__HEIMDALL_TOKEN` is unset/expired. Fix: refresh the cookie or set
  the token, then retry the same query.
- A single transient network/HTTP error from Heimdall (timeout, 5xx) with no
  pattern across retries.
- Confusion caused by a keybinding chord not firing — this is the known,
  documented FR-1/UoW-01 limitation (see README), not a bug. Use the palette
  command or `sqltools.disableChordKeybindings: true` instead of filing it.

**File a new entry in `units-of-work.md`:**
- A query result is silently wrong (not an error, wrong data) — this is a
  correctness bug, not an auth/environment issue.
- The safety gate (`src/gate.ts`, `src/heimdall/safety.ts`) fails to catch a
  non-read-only statement, or blocks a genuinely read-only one repeatedly.
- A crash or unhandled exception in the SQLTools output channel that
  reproduces on a fresh connection with valid, fresh credentials.
- Any of the already-known `ponytail:`-marked limitations actually causing
  user-visible harm beyond their documented ceiling (e.g. metadata cache
  entries never being cleaned up on `close()` visibly leaking across many
  reconnects) — reference the specific `ponytail:` comment location when
  filing.
- A version-matched pair (confirmed via step 4 above) still behaves
  inconsistently with what's documented — that's a genuine driver/core
  contract issue, not user error.
