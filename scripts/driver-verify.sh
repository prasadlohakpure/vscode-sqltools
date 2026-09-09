#!/usr/bin/env bash
# Commit gate for packages/driver.heimdall. Must pass before any change to that
# package is called done. Mirrors heimdall-vs-code-ext's build-verify.sh gate —
# same fail-fast, same reasons: a green `tsc --noEmit` alone has already missed
# two real bugs in this package (a `node:`-prefixed import this workspace's old
# @types/node can't resolve, and an unused import) that only the real esbuild
# bundle step caught.
#
# Usage: bash scripts/driver-verify.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail() {
  printf '\n=======================================\n'
  printf 'DRIVER-VERIFY: FAIL\n'
  printf 'Failing step: %s\n' "$1"
  printf '=======================================\n'
  exit 1
}

run() { # run <step label> <cmd...>
  local label="$1"; shift
  printf '\n==> %s\n' "$label"
  "$@" || fail "$label"
}

[ -d node_modules ] || fail "dependencies missing — run: yarn install"

run "1/3 typecheck: tsc --noEmit"      yarn workspace sqltools-driver-heimdall run test:tsc
run "2/3 bundle: esbuild (ext + ls)"   yarn workspace sqltools-driver-heimdall run build

# 3/3 test: whatever *.test.ts exists under packages/driver.heimdall, via the
# repo's own jest config (ts-jest) — no second test runner introduced. Zero
# test files is not a pass: a package with real logic (auth, safety, target
# resolution, all ported from a fully-tested sibling extension) and no
# runnable check for any of it is exactly the gap this gate exists to close.
printf '\n==> 3/3 test: jest (packages/driver.heimdall)\n'
test_files=$(find packages/driver.heimdall/test packages/driver.heimdall/src -name '*.test.ts' 2>/dev/null)
if [ -z "$test_files" ]; then
  fail "3/3 test: jest (no *.test.ts files found under packages/driver.heimdall/test or src)"
fi
run "3/3 test: jest (packages/driver.heimdall)" \
  npx --no-install jest packages/driver.heimdall --silent=false

printf '\n=======================================\n'
printf 'DRIVER-VERIFY: PASS\n'
printf 'typecheck + esbuild bundle + jest\n'
printf 'Artifact: packages/driver.heimdall/out/{extension.js,ls/plugin.js}\n'
printf 'not tested here: real SQLTools UI (connection save/connect/query-run) — that needs a live editor, see below.\n'
printf '=======================================\n'
