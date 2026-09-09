# Safety/results porting notes

- **Pre-execute confirmation gate: does not exist in this architecture.**
  Checked `packages/base-driver/src/index.ts` (`AbstractDriver.query()` is the
  only entry point a driver implements — no `beforeExecute`/`willRunQuery`
  hook) and grepped `packages/extension/src`, `packages/plugins`, and
  `packages/language-server` for any pre-execute confirm/veto mechanism —
  none exists. SQLTools' own "Run Query" command goes straight to
  `driver.query()`; it never asks the user anything first. The old
  extension's `showWarningMessage({ modal: true }, 'Run anyway')` gate in
  `extension.ts` (before `client.runJob` is ever called) has **no equivalent
  hook to port to** — a driver only gets called after the decision to run is
  already made.

- **LIMIT injection: fully portable, no issue.** `injectLimit` just rewrites
  the SQL string before it's sent to Heimdall. Nothing about it depends on a
  webview, a confirmation dialog, or any VS Code UI — it can be called
  straight from `driver.query()` (or wherever `src/ls/driver.ts` builds the
  job context) exactly as before.

- **Target-verification mismatch: `messages` is enough to surface it, but
  it's easy to miss.** `annotateResult`'s `messages` field is populated and
  IS shown by SQLTools' grid — but it's inline with results the user has to
  scroll to, not an interrupt. The old extension additionally fired
  `vscode.window.showErrorMessage(verified.message)` for a real mismatch
  (not the merely-`unverified` case). **Flagging for the scaffolding
  agent:** `src/ls/driver.ts` should keep that loud
  `vscode.window.showErrorMessage(...)` call for the `mismatch` case
  specifically — `messages` alone is too quiet for "Heimdall ran this on a
  different cluster than you picked." `unverified` (no mismatch, just
  unconfirmed) is fine as `messages`-only, matching the old extension's own
  choice not to toast on that case.

- **Safety regression — yes, real, and worth stating plainly.** In the old
  extension, a non-read-only statement (`isReadOnly` false) blocks execution
  behind a modal "Run anyway?" dialog — nothing is submitted to Heimdall
  until the user explicitly confirms. In this architecture, **there is no
  hook to block execution before `driver.query()` runs**, so a destructive
  statement (INSERT/UPDATE/DELETE/DROP/etc.) will now run immediately,
  with no confirmation gate at all, by the time it reaches this driver. The
  driver can still detect it (`isReadOnly`, ported verbatim in
  `heimdall/safety.ts`) and attach a warning via `annotateResult`'s
  `messages`, but that warning necessarily arrives **after** the statement
  already executed — advisory-after-the-fact, not a gate. This is a real,
  net loss of safety versus the current extension for destructive
  statements, not a wash. The only way to claw part of it back within
  SQLTools' architecture would be a confirmation the extension-side command
  handler (not the driver) shows before invoking SQLTools' run-query command
  — worth raising with whoever owns `src/ls/driver.ts`/command wiring, but
  that is out of this file's scope and not something `safety.ts` or
  `annotate.ts` alone can fix.
