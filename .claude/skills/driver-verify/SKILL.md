---
name: driver-verify
description: The commit gate for packages/driver.heimdall in this SQLTools fork. Runs typecheck, the real esbuild bundle, and jest in order and fails fast. Use before every commit, before declaring any change to the Heimdall driver done, and whenever asked to build, verify, check, test, or package it.
---

# driver-verify

**Every change to `packages/driver.heimdall` must pass this gate before it's called done.**
`tsc --noEmit` alone is not enough — it has already missed two real bugs in this package
(a `node:`-prefixed import this workspace's old `@types/node` can't resolve, and an unused
import that only surfaced once the real build ran) that only the esbuild bundle step caught.

## Run it

```bash
bash scripts/driver-verify.sh
```

Exit code 0 = pass. Non-zero = fail, and the last lines name the failing step.

## What it checks, in order

| # | Step | Command | Catches |
|---|---|---|---|
| 1 | typecheck | `yarn workspace sqltools-driver-heimdall run test:tsc` | type errors, without writing `out/` |
| 2 | bundle | `yarn workspace sqltools-driver-heimdall run build` | esbuild-only failures `tsc` doesn't see — this is not redundant with step 1, it has caught real bugs step 1 missed |
| 3 | test | `jest packages/driver.heimdall` (this repo's own `ts-jest` config, no second runner) | regressions in the ported pure modules (`heimdall/client.ts`, `targets.ts`, `safety.ts`, `auth.ts`) |

Fails fast: step N+1 does not run if step N failed.

**Step 3 fails on zero test files, not just on a failing one.** A package this logic-heavy
(auth resolution, safety-rail enforcement, target/cluster matching — all ported from a
fully-`node --test`-covered sibling extension) with no runnable check at all is exactly the
gap this gate exists to close, not a pass-by-default state.

## When it fails

- **typecheck** — fix the code. This fork's `@types/node` is 14.6.0: no `node:`-prefixed
  built-in imports anywhere in this package (`fs`/`os`/`path`, not `node:fs`/`node:os`/`node:path`)
  — already bitten twice.
- **bundle** — run `yarn workspace sqltools-driver-heimdall run build` alone to see the
  esbuild output directly.
- **test** — `npx jest packages/driver.heimdall` alone reruns just that step.

## What this gate does NOT catch — and why a change still needs a live check

This is pure-logic + bundle verification. It proves the code compiles, bundles, and the
pure modules behave — it does **not** prove the driver works inside a real SQLTools/VS Code
session. Two real issues already slipped past a green typecheck this way:

- A version mismatch between a marketplace-installed `mtxr.sqltools` core and a fork-built
  driver — only visible by actually connecting in a live editor.
- The connection **save** flow (`ext_addConnection` → `saveConnectionList`) depends on
  `workspace.getConfiguration().update(...)`'s target-inference behavior, which this gate
  cannot exercise at all (no `vscode` module outside a real extension host).

**After this gate passes, for any change touching `connection.schema.json`, `ui.schema.json`,
`extension.ts`, or `ls/driver.ts`'s connect/query path:** rebuild and reinstall both `.vsix`s
into a real Cursor/VS Code and manually exercise add-connection → save → connect → run query.
There is no automated substitute for this yet (see the reference extension's `test:e2e` for
the shape a future version of this could take — it drives a real Cursor via
`vscodeExecutablePath`, no ~300MB VS Code download, ~7.5s run time. Not built here yet because
this package has no activation/command test harness of its own).

## First run

```bash
yarn install
```

from the repo root. The script refuses to run without `node_modules`.
