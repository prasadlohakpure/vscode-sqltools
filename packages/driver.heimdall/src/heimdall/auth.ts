// Gatekeeper auth for the Heimdall client (UoW-02).
//
// Two disjoint modes, per requirements.md §10:
//   service-token — X-Pattern-Service from $PATTERN__HEIMDALL_TOKEN. The only browser-free path.
//   cookie-file   — Cookie: k=v; k=v assembled from the .cookies object in heimdall.json.
//
// Nothing in here ever logs, returns, or embeds a cookie value or token value in a message.
// Error text carries names and paths only.

// ponytail: `node:`-prefixed specifiers aren't resolvable under this
// workspace's older @types/node (14.6.0, pre-`node:` self-reference); bare
// specifiers are the drop-in fix, no other change from the ported original.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type AuthMode = 'service-token' | 'cookie-file';

export interface AuthHeaders {
  /** Which mode was chosen — for the status bar / preflight UI. */
  mode: AuthMode;
  /** Headers to attach to every Heimdall request. */
  headers: Record<string, string>;
  /** Where the material came from: an env var name or a file path. Never a value. */
  source: string;
  /** Set when `when_created` says the cookie file is likely stale. */
  staleWarning?: string;
}

export interface ResolveOptions {
  /** Email for X-Pattern-User attribution. Defaults to $PATTERN__HEIMDALL_USER. */
  user?: string;
  /** `vscode.env.remoteName` — undefined when local. Kept as a param so this file needs no vscode import. */
  remoteName?: string;
  /** Injectable clock for the staleness check. */
  now?: number;
  /** Override the cookie-file lookup chain. Exists so tests never touch a real credential file. */
  cookieFiles?: string[];
}

/** Cookies go stale at roughly a week; there is no refresh-token path (§10). */
export const COOKIE_MAX_AGE_DAYS = 7;

/**
 * Bug fix: was `mise run agent-sandbox:auth` — that's a thin `data-airflow`
 * repo task wrapper (`mkdir -p ~/.pattern/gatekeeper && cookie-monster`,
 * checked in that repo's `.mise.toml`) around the real tool, `cookie-monster`
 * itself, a standalone binary on `$PATH`. `mise` proved unreliable to invoke
 * from an automated terminal (not found in at least one shell context this
 * session hit), and the repo/cwd it wrapped was never actually needed —
 * `cookie-monster` runs from anywhere. Calling it directly removes both the
 * `mise`-availability dependency and the now-pointless data-airflow-repo
 * requirement. Exported so `extension.ts`'s cookie-refresh prompt runs the
 * exact same command, never a duplicated string.
 */
export const REFRESH_CMD = 'mkdir -p "$HOME/.pattern/gatekeeper" && cookie-monster';

/** Lookup order from requirements.md §10. */
export function cookieFileCandidates(): string[] {
  const override = process.env.PATTERN__HEIMDALL_COOKIES_FILE;
  return [
    ...(override ? [override] : []),
    join(homedir(), '.pattern', 'gatekeeper', 'heimdall.json'),
    '/etc/gatekeeper/heimdall.json',
  ];
}

/** `{a: '1', b: '2'}` → `a=1; b=2`. */
export function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** Whole days elapsed since a unix-epoch-seconds `when_created`. */
export function cookieAgeDays(whenCreated: number, now = Date.now()): number {
  return (now / 1000 - whenCreated) / 86400;
}

/**
 * NFR-12: expired cookies come back as an Okta HTML *redirect*, not a clean 401.
 * A client that follows the redirect parses a login page as a job result.
 */
export function isAuthFailure(status: number): boolean {
  return (status >= 300 && status < 400) || status === 401 || status === 403;
}

/** Merge auth headers into a fetch init and pin `redirect: 'manual'` (NFR-12). */
export function authFetchInit(auth: AuthHeaders, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...auth.headers, ...(init.headers as Record<string, string>) },
  };
}

/** Throws an actionable error if the response looks like an auth failure. */
export function assertAuthOk(res: { status: number }, auth?: AuthHeaders, opts: ResolveOptions = {}): void {
  if (!isAuthFailure(res.status)) {
    return;
  }
  const what = auth
    ? `${auth.mode} credentials from ${auth.source} were rejected or have expired`
    : 'Heimdall rejected the request as unauthenticated';
  throw new Error(
    `Heimdall auth failed (HTTP ${res.status}): ${what}.` +
      (res.status < 400 ? ' A 3xx here is an Okta login redirect, not a real result.' : '') +
      `\n${authFixes(opts)}`,
  );
}

/**
 * Resolve the headers to attach. Env token wins; cookie file is the laptop default.
 * Reads the credential file at most once and keeps nothing but the assembled header.
 */
export function resolveAuth(opts: ResolveOptions = {}): AuthHeaders {
  const user = opts.user ?? process.env.PATTERN__HEIMDALL_USER;
  const attribution: Record<string, string> = user ? { 'X-Pattern-User': user } : {};

  const token = process.env.PATTERN__HEIMDALL_TOKEN?.trim();
  if (token) {
    if (/[\x00-\x1f\x7f]/.test(token)) {
      throw new Error('PATTERN__HEIMDALL_TOKEN contains control characters and cannot be sent as a header.');
    }
    return {
      mode: 'service-token',
      source: 'env PATTERN__HEIMDALL_TOKEN',
      headers: { 'X-Pattern-Service': token, ...attribution },
    };
  }

  const candidates = opts.cookieFiles ?? cookieFileCandidates();
  for (const path of candidates) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue; // missing/unreadable — try the next location
    }

    let parsed: { cookies?: Record<string, string>; when_created?: number };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${path} is not valid JSON. Re-create it: run \`${REFRESH_CMD}\`.`);
    }

    const cookie = buildCookieHeader(parsed.cookies ?? {});
    if (!cookie) {
      throw new Error(`${path} has no .cookies entries.\n${authFixes(opts)}`);
    }

    const age = typeof parsed.when_created === 'number' ? cookieAgeDays(parsed.when_created, opts.now) : undefined;
    return {
      mode: 'cookie-file',
      source: path,
      headers: { Cookie: cookie, ...attribution },
      ...(age !== undefined && age > COOKIE_MAX_AGE_DAYS
        ? {
            staleWarning:
              `Gatekeeper cookies in ${path} are ${age.toFixed(1)} days old (stale after ~${COOKIE_MAX_AGE_DAYS}). ` +
              `Queries will likely fail — run \`${REFRESH_CMD}\`.`,
          }
        : {}),
    };
  }

  throw new Error(
    `No Heimdall credentials found. PATTERN__HEIMDALL_TOKEN is unset and no Gatekeeper cookie file exists at: ` +
      `${candidates.join(', ')}.\n${authFixes(opts)}`,
  );
}

/**
 * The actionable half of every auth failure message: how to get a working
 * session back. Exported so the extension host can append it to a
 * `HeimdallAuthError` raised mid-query (UoW-07) — an expired cookie surfaces as
 * a transport failure there, not through `assertAuthOk`, and an opaque 401 with
 * no named fix is exactly what UoW-02 set out to avoid.
 */
export function authFixes(opts: ResolveOptions = {}): string {
  const lines = [
    `Fix (laptop): run \`${REFRESH_CMD}\` — opens a browser for Okta.`,
    'Fix (headless): set PATTERN__HEIMDALL_TOKEN, plus PATTERN__HEIMDALL_USER so jobs are attributed to you and not the bare service account.',
  ];
  if (opts.remoteName) {
    lines.unshift(
      `You are on a remote workspace (${opts.remoteName}). cookie-monster needs a local browser and may need an MFA tap, ` +
        'so it cannot refresh cookies here — PATTERN__HEIMDALL_TOKEN is the remote-friendly option (NFR-8).',
    );
  }
  return lines.join('\n');
}
