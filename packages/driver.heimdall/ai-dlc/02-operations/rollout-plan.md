# Rollout plan — SQLTools Heimdall driver

**UoW-04 / US-7 (FR-7).** Both packages are `private: true`, `-SNAPSHOT`
versioned, and hand-installed by `.vsix`. This is not a marketplace product —
it is an internal Pattern tool distributed machine-by-machine.

## How this reaches the team

There is no CI publish step and no marketplace listing. Distribution is:

1. Someone (author or a teammate with the repo checked out) builds both
   `.vsix` files from a single, clean checkout of this fork at one commit.
2. Those two files (or a link to where they're dropped — e.g. a Slack
   message, an internal share) go to the teammate who wants Heimdall.
3. The teammate runs `scripts/install-heimdall.sh`, or runs the two
   `--install-extension` commands below by hand.

There is no auto-update. Getting a new version means repeating this — a new
build, a new pair of `.vsix` files, install again (the CLI overwrites the
previous version of each extension in place).

## The matched-pair rule

**Core and driver must always come from the same build pass of this fork.**
This has already bitten once in this project: a marketplace-installed
`mtxr.sqltools` core mixed with a fork-built driver risks a silent
API/contract mismatch between the language-server protocol the core ships
and the one the driver was built against — no install-time error, just wrong
behavior later. The rule:

- Never install `mtxr.sqltools` from the VS Code / Cursor Marketplace
  alongside `pattern.sqltools-driver-heimdall`.
- Always build (or obtain) both `.vsix` files from the same checkout/commit
  of this fork, and install both.

## Exact build + install invocations

Build (repo root):

```bash
# core — packages/extension, produces sqltools-<version>-SNAPSHOT.vsix at repo root
yarn run build:pack

# driver — produces sqltools-driver-heimdall-<version>-SNAPSHOT.vsix in packages/driver.heimdall/
yarn workspace sqltools-driver-heimdall run package
```

Install (matched pair, same commit):

```bash
# find your editor's CLI first — see scripts/install-heimdall.sh for the search order
<editor-cli> --install-extension sqltools-<version>-SNAPSHOT.vsix
<editor-cli> --install-extension packages/driver.heimdall/sqltools-driver-heimdall-<version>-SNAPSHOT.vsix
```

`<editor-cli>` is `cursor` or `code`. On macOS, Cursor's CLI is not always on
`$PATH`; it has been found at
`/Applications/Cursor.app/Contents/Resources/app/bin/cursor` in this project.
Use `scripts/install-heimdall.sh` rather than typing these by hand — it does
the same thing plus the mismatch check below.

## Rollback

If the Heimdall driver needs to come out, or the pair needs to be undone:

```bash
# 1. Remove the fork-built driver
<editor-cli> --uninstall-extension pattern.sqltools-driver-heimdall

# 2. Remove the fork-built core and reinstall the real upstream SQLTools
<editor-cli> --uninstall-extension mtxr.sqltools
<editor-cli> --install-extension mtxr.sqltools   # pulls the marketplace build
```

Step 2 is only needed if the fork-built core was installed to begin with —
if a machine already had upstream `mtxr.sqltools` from the Marketplace and
only the driver was added on top, uninstalling the driver alone is enough
(but that machine was, until then, in the mismatched state this plan warns
against — installing the driver against a marketplace core was never a
supported combination, only a state to get out of).

## Definition of done (short of marketplace publishing)

This rollout is "done" when:

- Both `.vsix` files build cleanly via `scripts/driver-verify.sh` (or the
  build-verify skill's checks) from a single commit.
- `scripts/install-heimdall.sh` installs the matched pair on a clean editor
  profile without manual steps beyond running the script.
- `packages/driver.heimdall/README.md` documents install, prerequisites, and
  known limitations well enough that a teammate can self-serve without
  reading source.
- Both `package.json` files remain `private: true`. **Marketplace publishing
  is explicitly out of scope** — this is an internal tool, distributed by
  `.vsix`, indefinitely. Nothing in this plan changes that.
