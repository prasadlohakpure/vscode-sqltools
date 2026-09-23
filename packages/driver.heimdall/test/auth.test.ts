// Synthetic fixtures only — never reads the real ~/.pattern/gatekeeper/heimdall.json.
// Ported from heimdall-vs-code-ext's test/auth.test.js — see UoW-03.
// NFR-1: bare specifiers, not `node:`-prefixed — this workspace's @types/node
// (14.6.0) can't resolve the `node:` self-reference.
import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  assertAuthOk,
  cookieFileCandidates,
  authFetchInit,
  buildCookieHeader,
  cookieAgeDays,
  isAuthFailure,
  resolveAuth,
} from '../src/heimdall/auth';

const DAY = 86400;
const fixtureDir = mkdtempSync(join(tmpdir(), 'heimdall-auth-test-'));

function fixture(name: string, body: unknown): string {
  const path = join(fixtureDir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

/** assert.throws returns undefined, so grab the error to make further assertions on it. */
function grab(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail('expected a throw');
}

beforeEach(() => {
  delete process.env.PATTERN__HEIMDALL_TOKEN;
  delete process.env.PATTERN__HEIMDALL_USER;
  delete process.env.PATTERN__HEIMDALL_COOKIES_FILE;
});

test('cookie header assembly', () => {
  assert.equal(buildCookieHeader({ sid: 'aaa', csrf: 'bbb' }), 'sid=aaa; csrf=bbb');
  assert.equal(buildCookieHeader({}), '');
});

test('cookie file lookup order: env override, then home, then /etc', () => {
  assert.deepEqual(cookieFileCandidates().length, 2);
  process.env.PATTERN__HEIMDALL_COOKIES_FILE = '/nowhere/override.json';
  const candidates = cookieFileCandidates();
  assert.equal(candidates[0], '/nowhere/override.json');
  assert.match(candidates[1], /\.pattern\/gatekeeper\/heimdall\.json$/);
  assert.equal(candidates[2], '/etc/gatekeeper/heimdall.json');
});

test('cookie file mode sends a Cookie header and reports its source', () => {
  const path = fixture('fresh.json', {
    cookies: { gk_session: 'synthetic-1', gk_csrf: 'synthetic-2' },
    when_created: Math.floor(Date.now() / 1000) - DAY,
  });

  const auth = resolveAuth({ user: 'someone@pattern.com', cookieFiles: [path] });
  assert.equal(auth.mode, 'cookie-file');
  assert.equal(auth.source, path);
  assert.equal(auth.headers.Cookie, 'gk_session=synthetic-1; gk_csrf=synthetic-2');
  assert.equal(auth.headers['X-Pattern-User'], 'someone@pattern.com');
  assert.equal(auth.staleWarning, undefined);
  assert.equal(auth.headers['X-Pattern-Service'], undefined);
});

test('env token takes precedence over an existing cookie file', () => {
  const path = fixture('ignored.json', {
    cookies: { gk_session: 'synthetic-1' },
    when_created: Math.floor(Date.now() / 1000),
  });
  process.env.PATTERN__HEIMDALL_TOKEN = 'synthetic-token';
  process.env.PATTERN__HEIMDALL_USER = 'someone@pattern.com';

  const auth = resolveAuth({ cookieFiles: [path] });
  assert.equal(auth.mode, 'service-token');
  assert.equal(auth.source, 'env PATTERN__HEIMDALL_TOKEN');
  assert.equal(auth.headers['X-Pattern-Service'], 'synthetic-token');
  assert.equal(auth.headers['X-Pattern-User'], 'someone@pattern.com');
  assert.equal(auth.headers.Cookie, undefined);
});

test('NFR-12: 3xx, 401 and 403 all classify as auth failure; 2xx/4xx-other/5xx do not', () => {
  for (const s of [300, 302, 307, 399, 401, 403]) {
    assert.equal(isAuthFailure(s), true, `${s} should be an auth failure`);
  }
  for (const s of [200, 201, 400, 404, 429, 500]) {
    assert.equal(isAuthFailure(s), false, `${s} should not be an auth failure`);
  }
  assert.throws(() => assertAuthOk({ status: 302 }), /Okta login redirect/);
  assert.throws(() => assertAuthOk({ status: 401 }), /cookie-monster/);
  assert.doesNotThrow(() => assertAuthOk({ status: 200 }));
});

test('fetch init never follows redirects', () => {
  process.env.PATTERN__HEIMDALL_TOKEN = 'synthetic-token';
  const init: any = authFetchInit(resolveAuth(), { method: 'POST' });
  assert.equal(init.redirect, 'manual');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
});

test('staleness from when_created', () => {
  const now = 10 * DAY * 1000;
  assert.equal(cookieAgeDays(9 * DAY, now), 1);
  assert.equal(cookieAgeDays(now / 1000, now), 0);

  const path = fixture('stale.json', {
    cookies: { gk_session: 'synthetic-1' },
    when_created: DAY, // 9 days before `now`
  });
  const auth = resolveAuth({ now, cookieFiles: [path] });
  assert.match(auth.staleWarning || '', /9\.0 days old/);
  assert.match(auth.staleWarning || '', /cookie-monster/);
});

test('missing credentials produce an actionable error, remote-aware', () => {
  const absent = [join(fixtureDir, 'does-not-exist.json')];

  const local = grab(() => resolveAuth({ cookieFiles: absent }));
  assert.match(local.message, /No Heimdall credentials found/);
  assert.match(local.message, /cookie-monster/);
  assert.match(local.message, /PATTERN__HEIMDALL_TOKEN/);
  assert.doesNotMatch(local.message, /remote workspace/);

  const remote = grab(() => resolveAuth({ remoteName: 'ssh-remote', cookieFiles: absent }));
  assert.match(remote.message, /remote workspace \(ssh-remote\)/);
  assert.match(remote.message, /needs a local browser/);
});

test('a cookie file with no cookies is treated as missing credentials, not as empty auth', () => {
  const path = fixture('empty.json', { cookies: {}, when_created: 1 });
  assert.throws(() => resolveAuth({ cookieFiles: [path] }), /has no \.cookies entries/);
});
