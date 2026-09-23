// The one seam between this package's two processes.
//
// A SQLTools driver is split across two bundles that share no memory:
//
//   src/extension.ts  -> out/extension.js   (VS Code extension host; HAS `vscode`)
//   src/ls/plugin.ts  -> out/ls/plugin.js   (SQLTools language server; NO `vscode`)
//
// Anything the user clicks lives in the first; the metadata cache and the
// Heimdall client live in the second. SQLTools already runs a JSON-RPC
// connection between them (the language client), and it lets a driver borrow
// it in both directions:
//
//   ext -> LS   `extension.client.sendRequest(method, params)`   (extension.ts)
//   LS  -> ext  `server.sendRequest(method, params)`             (plugin.ts's `register(server)`)
//   LS  handles `server.onRequest(method, handler)`
//   ext handles `extension.client.onRequest(method, handler)`
//
// SQLTools' own `connection/GetConnectionPasswordRequest` is the precedent for
// the LS->ext direction (see packages/plugins/connection-manager/), so this is
// a supported pattern rather than a hack.
//
// Why a file of bare strings instead of `RequestType` objects like SQLTools'
// own `contracts.ts`: `RequestType` comes from `vscode-jsonrpc`, which this
// package does not depend on and would have to add to both bundles purely to
// get a nominal type wrapper around a method name. `sendRequest`/`onRequest`
// both accept a plain string method, so a string plus an exported param/result
// type gets the same compile-time safety for free.
//
// ponytail: method names are globally namespaced by the `heimdall/` prefix and
// nothing enforces that the handler side actually registered. A request to an
// unregistered method rejects, which every caller here already treats as
// "feature unavailable" rather than crashing. If a third bundle ever joins,
// promote these to real `RequestType`s so the params are checked at the RPC
// boundary too, not just at our own call sites.

/**
 * ext -> LS. Force the metadata cache to re-crawl the target's catalog
 * regardless of TTL staleness, then resolve once the cache holds fresh data.
 * The caller is expected to trigger `sqltools.refreshTree` afterwards so
 * SQLTools re-renders from the now-fresh cache (see src/explorer/NOTES.md on
 * why the native refresh alone is only a re-render).
 */
export const REFRESH_METADATA = 'heimdall/refreshMetadata';

/**
 * ext -> LS. Empty the metadata cache so the next tree expansion does a fresh
 * crawl. The only way to invalidate a target holding wrong data (e.g. after a
 * catalog change) without waiting out the TTL.
 */
export const CLEAR_METADATA = 'heimdall/clearMetadata';

/**
 * LS -> ext, one-way. US-2/FR-2: raised from inside `driver.ts`'s `query()`
 * the moment `verifyResolvedTarget` reports `state === 'mismatch'` — the
 * merely-`unverified` state stays `messages`-only and never sends this (don't
 * cry wolf on "couldn't confirm"). Carries nothing beyond what
 * `heimdall/targets.ts`'s `TargetVerification` already computes for the
 * mismatch case.
 */
export const TARGET_MISMATCH = 'heimdall/targetMismatch';

/**
 * LS -> ext, one-way. Raised from `driver.ts`'s `buildAuth()` whenever the
 * Gatekeeper cookie chain yields nothing usable. `extension.ts`'s own
 * `cookieStatus()` pre-checks only cover the commands it wraps or hooks;
 * connecting (`open()`), tree expansion and metadata all reach `buildAuth()`
 * through paths with no such pre-check, where the missing cookie surfaced as
 * nothing but core SQLTools' "Error opening connection" toast. This lets the
 * one place that actually detects the problem trigger the refresh.
 */
export const COOKIE_REFRESH_REQUIRED = 'heimdall/cookieRefreshRequired';

/** Params for `COOKIE_REFRESH_REQUIRED`. Paths and reasons only — never cookie values. */
export interface CookieRefreshParams {
  /** `missing` — no candidate file exists. `unusable` — a file exists but can't be parsed or holds no cookies. `stale` — older than `COOKIE_MAX_AGE_DAYS`. */
  reason: 'missing' | 'unusable' | 'stale';
  /** The offending file, when one was found. */
  path?: string;
}

/** Params for `TARGET_MISMATCH` — the mismatch-case fields of `TargetVerification`. */
export interface TargetMismatchParams {
  /** `verifyResolvedTarget`'s human-readable explanation; always set for a mismatch. */
  message: string;
  expected: { command: string; cluster: string };
  actual: { command?: string; cluster?: string };
}

/**
 * Params for both metadata requests.
 *
 * `connId` identifies which connection's driver instance to act on — the LS
 * hosts one driver per connection, so a cache command with no connection is
 * ambiguous. The extension host gets this from SQLTools' active connection
 * (`api.getActiveConnection()`-equivalent); when it cannot determine one, it
 * should tell the user to connect rather than guessing a driver.
 */
export interface MetadataRequestParams {
  connId: string;
}

/** Result for both metadata requests: a short, already-human-readable outcome for a toast. */
export interface MetadataRequestResult {
  /** e.g. "Refreshed 42 namespaces / 1180 tables (3 not refreshed)" or "Metadata cache cleared". */
  message: string;
}
