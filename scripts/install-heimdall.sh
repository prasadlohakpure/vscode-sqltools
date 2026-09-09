#!/usr/bin/env bash
# Builds (or locates) the matched core+driver .vsix pair for the SQLTools
# Heimdall driver and installs both into cursor or code. Internal tool only —
# see packages/driver.heimdall/ai-dlc/02-operations/rollout-plan.md.
#
# Usage: bash scripts/install-heimdall.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DRIVER_DIR="$ROOT/packages/driver.heimdall"

fail() { printf '\nINSTALL-HEIMDALL: FAIL — %s\n' "$1" >&2; exit 1; }
warn() { printf 'INSTALL-HEIMDALL: WARN — %s\n' "$1" >&2; }
info() { printf '==> %s\n' "$1"; }

command -v node >/dev/null || fail "node not found"

# ---- expected versions (source of truth: package.json of each package) ----
CORE_VERSION=$(node -p "require('./packages/extension/package.json').version")
DRIVER_VERSION=$(node -p "require('./packages/driver.heimdall/package.json').version")
[ -n "$CORE_VERSION" ] && [ -n "$DRIVER_VERSION" ] || fail "could not read versions from package.json files"
info "expected matched pair: sqltools $CORE_VERSION / sqltools-driver-heimdall $DRIVER_VERSION"

# ---- locate or build each .vsix ----
find_vsix() { # find_vsix <dir> <name-prefix>
  find "$1" -maxdepth 1 -name "$2-*.vsix" 2>/dev/null | sort | tail -1
}

CORE_VSIX=$(find_vsix "$ROOT" "sqltools")
# exclude the driver's own vsix if it also lives at repo root
if [ -n "$CORE_VSIX" ] && [[ "$(basename "$CORE_VSIX")" == sqltools-driver-heimdall-* ]]; then
  CORE_VSIX=""
fi
if [ -z "$CORE_VSIX" ]; then
  info "core .vsix not found at repo root — building (yarn run build:pack)"
  (cd "$ROOT" && yarn run build:pack) || fail "yarn run build:pack failed"
  CORE_VSIX=$(find_vsix "$ROOT" "sqltools")
fi
[ -n "$CORE_VSIX" ] || fail "core .vsix still not found after build"

DRIVER_VSIX=$(find_vsix "$DRIVER_DIR" "sqltools-driver-heimdall")
if [ -z "$DRIVER_VSIX" ]; then
  info "driver .vsix not found — building (yarn workspace sqltools-driver-heimdall run package)"
  (cd "$ROOT" && yarn workspace sqltools-driver-heimdall run package) || fail "driver package build failed"
  DRIVER_VSIX=$(find_vsix "$DRIVER_DIR" "sqltools-driver-heimdall")
fi
[ -n "$DRIVER_VSIX" ] || fail "driver .vsix still not found after build"

info "core:   $CORE_VSIX"
info "driver: $DRIVER_VSIX"

# ---- fail loudly if the pair doesn't match the recorded expected versions ----
# A .vsix filename is <name>-<version>.vsix (vsce's own naming), so the
# version is right there in the filename — no unzip needed.
core_vsix_version=$(basename "$CORE_VSIX" .vsix | sed -E 's/^sqltools-//')
driver_vsix_version=$(basename "$DRIVER_VSIX" .vsix | sed -E 's/^sqltools-driver-heimdall-//')

[ "$core_vsix_version" = "$CORE_VERSION" ] || fail \
  "core .vsix version '$core_vsix_version' does not match packages/extension/package.json version '$CORE_VERSION' — stale build? Re-run 'yarn run build:pack'."
[ "$driver_vsix_version" = "$DRIVER_VERSION" ] || fail \
  "driver .vsix version '$driver_vsix_version' does not match packages/driver.heimdall/package.json version '$DRIVER_VERSION' — stale build? Re-run 'yarn workspace sqltools-driver-heimdall run package'."

# ---- find an editor CLI: cursor preferred, then code ----
find_cli() {
  for name in cursor code; do
    if command -v "$name" >/dev/null 2>&1; then
      command -v "$name"
      return 0
    fi
  done
  for candidate in \
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

EDITOR_CLI=$(find_cli) || fail "no 'cursor' or 'code' CLI found on \$PATH or in common macOS app locations — install one and retry"
info "editor CLI: $EDITOR_CLI"

# ---- warn (don't silently overwrite) if a marketplace core is present ----
if "$EDITOR_CLI" --list-extensions --show-versions 2>/dev/null | grep -qi '^mtxr\.sqltools@'; then
  installed_core=$("$EDITOR_CLI" --list-extensions --show-versions 2>/dev/null | grep -i '^mtxr\.sqltools@')
  warn "an existing 'mtxr.sqltools' is already installed ($installed_core)."
  warn "this will be overwritten with the fork-built core ($CORE_VERSION) below."
  warn "if that existing install came from the Marketplace (not this fork), mixing it with the Heimdall driver has already caused a silent API mismatch once in this project — see rollout-plan.md."
fi

# ---- install the matched pair (--force so the same -SNAPSHOT vsix overwrites) ----
info "installing core..."
"$EDITOR_CLI" --install-extension "$CORE_VSIX" --force || fail "core install failed"
info "installing driver..."
"$EDITOR_CLI" --install-extension "$DRIVER_VSIX" --force || fail "driver install failed"

info "reloading editor window..."
"$EDITOR_CLI" --reuse-window --command workbench.action.reloadWindow || warn "could not reload automatically — run 'Developer: Reload Window' yourself"

printf '\nINSTALL-HEIMDALL: DONE — matched pair sqltools %s / sqltools-driver-heimdall %s installed.\n' "$CORE_VERSION" "$DRIVER_VERSION"
