#!/usr/bin/env bash
# Installs the Heimdall SQLTools setup from .vsix files sitting next to THIS
# script — no repo checkout, no yarn/node, no build step. For handing a
# teammate a folder containing this script plus the .vsix files (or for
# running from inside the repo once you've already built them once).
#
# Looks for, and installs whichever it finds (core + driver required,
# charts optional):
#   sqltools-<version>.vsix                    (fork-built core)
#   sqltools-driver-heimdall-<version>.vsix     (Heimdall driver)
#   sqltools-charts-<version>.vsix              (optional: charts + query output, driver-agnostic)
#
# Usage: bash install-from-vsix.sh
#   (from wherever the script and the .vsix files live together)
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

fail() { printf '\nINSTALL-FROM-VSIX: FAIL — %s\n' "$1" >&2; exit 1; }
warn() { printf 'INSTALL-FROM-VSIX: WARN — %s\n' "$1" >&2; }
info() { printf '==> %s\n' "$1"; }

# find_one <name-prefix> [-not -name ...] — newest match if more than one,
# empty if none. (`.vsix` filenames are vsce's own `<name>-<version>.vsix`,
# so a plain lexical sort is enough to prefer a higher version without
# parsing semver.)
find_one() {
  local prefix="$1"; shift
  find "$DIR" -maxdepth 1 -name "$prefix-*.vsix" "$@" 2>/dev/null | sort | tail -1
}

# `sqltools-driver-heimdall-*.vsix` and `sqltools-charts-*.vsix` both also
# match a bare `sqltools-*.vsix` glob, so the core lookup must exclude them
# up front — filtering the top pick *after* the fact (rather than excluding
# before `sort | tail -1`) would just come up empty when one of those two
# happens to sort last, instead of falling through to the real core file.
CORE_VSIX=$(find_one "sqltools" -not -name "sqltools-driver-heimdall-*" -not -name "sqltools-charts-*")
DRIVER_VSIX=$(find_one "sqltools-driver-heimdall")
CHARTS_VSIX=$(find_one "sqltools-charts")

[ -n "$CORE_VSIX" ] || fail "no sqltools-*.vsix (core) found next to this script in $DIR"
[ -n "$DRIVER_VSIX" ] || fail "no sqltools-driver-heimdall-*.vsix found next to this script in $DIR"

info "core:   $(basename "$CORE_VSIX")"
info "driver: $(basename "$DRIVER_VSIX")"
if [ -n "$CHARTS_VSIX" ]; then
  info "charts: $(basename "$CHARTS_VSIX") (optional, found — will install)"
else
  info "charts: not found next to script — skipping (optional)"
fi

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
  warn "this will be overwritten with the fork-built core below."
  warn "if that existing install came from the Marketplace (not this fork), mixing it with the Heimdall driver has already caused a silent API mismatch once in this project."
fi

# ---- install (--force so a same-version -SNAPSHOT vsix still overwrites) ----
info "installing core..."
"$EDITOR_CLI" --install-extension "$CORE_VSIX" --force || fail "core install failed"
info "installing driver..."
"$EDITOR_CLI" --install-extension "$DRIVER_VSIX" --force || fail "driver install failed"
if [ -n "$CHARTS_VSIX" ]; then
  info "installing charts..."
  "$EDITOR_CLI" --install-extension "$CHARTS_VSIX" --force || warn "charts install failed (optional component, continuing)"
fi

printf '\nINSTALL-FROM-VSIX: DONE. Fully quit and reopen %s for the update to take effect.\n' "$(basename "$EDITOR_CLI")"
