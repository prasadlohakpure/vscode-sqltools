// No framework, no HTTP mocking library — `fetch` is injected.
// Ported from heimdall-vs-code-ext's test/heimdall-client.test.js — see UoW-03.
import assert from 'assert';

import {
  HeimdallAuthError,
  HeimdallClient,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  isTerminalStatus,
  parseQueryResult,
  sqlContext,
} from '../src/heimdall/client';

/** Structurally an `AuthHeaders` from src/heimdall/auth.ts. The value must never be logged. */
const auth = {
  mode: 'service-token',
  source: 'env PATTERN__HEIMDALL_TOKEN',
  headers: { 'X-Pattern-Service': 'super-secret-token' },
};

/** Minimal Response stand-in: only what the client actually reads. */
function res(status: number, body: unknown, statusText = ''): any {
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Returns a fetch stub that replays `responses` and records the URLs called. */
function stubFetch(responses: unknown[]): any {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    if (responses.length === 0) {
      throw new Error(`unexpected extra fetch: ${url}`);
    }
    return responses.shift();
  };
  fn.calls = calls;
  return fn;
}

test('status enum has all eight wire values and no invented ones', () => {
  assert.deepEqual([...JOB_STATUSES].sort(), [
    'ACCEPTED',
    'CANCELED',
    'CANCELING',
    'FAILED',
    'KILLED',
    'NEW',
    'RUNNING',
    'SUCCEEDED',
  ]);
  // The two bugs this port exists to kill.
  assert.ok(!(JOB_STATUSES as readonly string[]).includes('PENDING'), 'PENDING is not a Heimdall status');
  assert.ok(!(JOB_STATUSES as readonly string[]).includes('INVALID'), 'INVALID is not a Heimdall status');
});

test('terminal set is exactly the four, and CANCELING is not terminal', () => {
  assert.deepEqual([...TERMINAL_JOB_STATUSES].sort(), [
    'CANCELED',
    'FAILED',
    'KILLED',
    'SUCCEEDED',
  ]);
  assert.equal(isTerminalStatus('CANCELING'), false);
  assert.equal(isTerminalStatus('CANCELED'), true);
  assert.equal(isTerminalStatus('NEW'), false);
  assert.equal(isTerminalStatus('PENDING'), false);
});

test('an empty result marshalled as {} parses to zero rows without throwing', () => {
  assert.deepEqual(parseQueryResult({}), { columns: [], data: [] });
  // columns present, data omitempty-dropped
  assert.deepEqual(parseQueryResult({ columns: [{ name: 'k', type: 'varchar' }] }), {
    columns: [{ name: 'k', type: 'varchar' }],
    data: [],
  });
  assert.deepEqual(parseQueryResult({ data: [[1, 'a']] }), {
    columns: [],
    data: [[1, 'a']],
  });
});

test('getJobResult tolerates {} end to end', async () => {
  const c = new HeimdallClient({
    auth,
    fetch: stubFetch([res(200, {})]),
  });
  assert.deepEqual(await c.getJobResult('job-1'), { columns: [], data: [] });
});

test('next_cursor pagination walks pages and stops', async () => {
  const fetchStub = stubFetch([
    res(200, {
      data: [{ id: 'a', name: 'n', version: '1', status: 'SUCCEEDED' }],
      has_more: true,
      next_cursor: 'c1',
    }),
    res(200, {
      data: [{ id: 'b', name: 'n', version: '1', status: 'FAILED' }],
      has_more: true,
      next_cursor: 'c2',
    }),
    // has_more false ends the walk even though a cursor is still present.
    res(200, {
      data: [{ id: 'c', name: 'n', version: '1', status: 'CANCELED' }],
      has_more: false,
      next_cursor: 'c3',
    }),
  ]);
  const c = new HeimdallClient({ auth, fetch: fetchStub });

  const ids: string[] = [];
  for await (const job of c.iterateJobs({ username: 'me@pattern.com' })) {
    ids.push(job.id);
  }

  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(fetchStub.calls.length, 3, 'stopped after the non-has_more page');
  assert.ok(!fetchStub.calls[0].includes('cursor='));
  assert.ok(fetchStub.calls[1].includes('cursor=c1'));
  assert.ok(fetchStub.calls[2].includes('cursor=c2'));
});

test('listJobs clamps limit at the server page size', async () => {
  const fetchStub = stubFetch([res(200, { data: [], has_more: false })]);
  const c = new HeimdallClient({ auth, fetch: fetchStub });
  await c.listJobs({ limit: 5000 });
  assert.ok(fetchStub.calls[0].includes('limit=101'), fetchStub.calls[0]);
});

test('a 302 is an auth failure, is not followed, and is not retried', async () => {
  const fetchStub = stubFetch([res(302, '<html>okta login</html>')]);
  const logged: string[] = [];
  const c = new HeimdallClient({
    auth,
    fetch: fetchStub,
    log: (m) => logged.push(m),
    retryDelayMs: 0,
  });

  await assert.rejects(() => c.getJobStatus('job-1'), (err: any) => {
    assert.ok(err instanceof HeimdallAuthError, `got ${err.name}`);
    assert.equal(err.status, 302);
    return true;
  });

  assert.equal(fetchStub.calls.length, 1, 'auth failure must not be retried');
  // Method/path/status only — never a header value.
  assert.deepEqual(logged, ['GET /api/v1/job/job-1/status -> 302']);
  assert.ok(!logged.join('\n').includes('super-secret-token'));
});

test('an auth failure names the credential source but never the secret', async () => {
  const c = new HeimdallClient({ auth, fetch: stubFetch([res(401, '')]) });
  await assert.rejects(() => c.getJob('job-1'), (err: any) => {
    assert.match(err.message, /service-token credentials from env PATTERN__HEIMDALL_TOKEN/);
    assert.ok(!err.message.includes('super-secret-token'));
    return true;
  });
});

test('401 and 403 classify with 3xx', async () => {
  for (const status of [401, 403, 301, 307]) {
    const c = new HeimdallClient({ auth, fetch: stubFetch([res(status, '')]) });
    await assert.rejects(() => c.getJob('job-1'), HeimdallAuthError, `status ${status}`);
  }
});

test('runJob short-circuits on an inline result from the submit response', async () => {
  const inline = { columns: [{ name: 'k', type: 'varchar' }], data: [['v']] };
  const fetchStub = stubFetch([
    res(200, {
      id: 'job-9',
      name: 'n',
      version: '1',
      status: 'SUCCEEDED',
      is_sync: true,
      result: inline,
    }),
  ]);
  const c = new HeimdallClient({ auth, fetch: fetchStub });

  const out = await c.runJob({
    name: 'n',
    version: '1',
    context: { query: 'select 1' },
    command_criteria: ['type:kyuubi'],
    cluster_criteria: ['type:kyuubi'],
  });

  assert.deepEqual(out.result, inline);
  assert.equal(fetchStub.calls.length, 1, 'no poll, no result fetch');
});

test('runJob polls /status (not /job/{id}) then fetches /result', async () => {
  const fetchStub = stubFetch([
    res(200, { id: 'job-7', name: 'n', version: '1', status: 'NEW' }),
    res(200, { status: 'RUNNING' }),
    res(200, { status: 'SUCCEEDED' }),
    res(200, { columns: [{ name: 'x', type: 'integer' }], data: [[1]] }),
  ]);
  const c = new HeimdallClient({ auth, fetch: fetchStub, retryDelayMs: 0 });

  const out = await c.runJob(
    {
      name: 'n',
      version: '1',
      context: { query: 'select 1' },
      command_criteria: ['type:kyuubi'],
      cluster_criteria: ['type:kyuubi'],
    },
    { intervalMs: 0, maxIntervalMs: 0 },
  );

  assert.deepEqual(out.result, { columns: [{ name: 'x', type: 'integer' }], data: [[1]] });
  assert.ok(fetchStub.calls[1].endsWith('/job/job-7/status'), fetchStub.calls[1]);
  assert.ok(fetchStub.calls[2].endsWith('/job/job-7/status'), fetchStub.calls[2]);
  assert.ok(fetchStub.calls[3].endsWith('/job/job-7/result'), fetchStub.calls[3]);
});

test('waitForJob stops on CANCELED instead of hanging (the Python client bug)', async () => {
  const fetchStub = stubFetch([
    res(200, { status: 'CANCELING' }),
    res(200, { status: 'CANCELED' }),
  ]);
  const c = new HeimdallClient({ auth, fetch: fetchStub });
  const final = await c.waitForJob('job-3', { intervalMs: 0, maxIntervalMs: 0 });
  assert.equal(final.status, 'CANCELED');
  assert.equal(fetchStub.calls.length, 2);
});

test('a failed SQL statement is surfaced, never retried', async () => {
  const fetchStub = stubFetch([
    res(200, {
      id: 'job-4',
      name: 'n',
      version: '1',
      status: 'FAILED',
      error: 'line 1:8: Column not found',
    }),
  ]);
  const c = new HeimdallClient({ auth, fetch: fetchStub });

  await assert.rejects(
    () =>
      c.runJob({
        name: 'n',
        version: '1',
        context: { query: 'select nope' },
        command_criteria: ['type:kyuubi'],
        cluster_criteria: ['type:kyuubi'],
      }),
    (err: any) => {
      assert.equal(err.name, 'HeimdallJobFailedError');
      assert.equal(err.jobStatus, 'FAILED');
      assert.match(err.message, /Column not found/);
      return true;
    },
  );
  assert.equal(fetchStub.calls.length, 1);
});

test('transport 502 retries, then succeeds', async () => {
  const fetchStub = stubFetch([
    res(502, '', 'Bad Gateway'),
    res(200, { data: [], has_more: false }),
  ]);
  const c = new HeimdallClient({ auth, fetch: fetchStub, retryDelayMs: 0 });
  const page = await c.listCommands();
  assert.deepEqual(page.data, []);
  assert.equal(fetchStub.calls.length, 2);
});

// This workspace's jest (26 / jest-environment-node 24) predates Node's
// AbortController becoming a VM global, so the client's own runtime has it
// but the test sandbox doesn't — a minimal stand-in covering exactly what
// `sleep()` in src/heimdall/client.ts reads (`signal.aborted`, `.reason`,
// add/removeEventListener('abort', ...)).
class FakeAbortController {
  private listeners: Array<() => void> = [];
  signal = {
    aborted: false,
    reason: undefined as unknown,
    addEventListener: (_: 'abort', fn: () => void) => {
      this.listeners.push(fn);
    },
    removeEventListener: (_: 'abort', fn: () => void) => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    },
  };
  abort(reason?: unknown) {
    this.signal.aborted = true;
    this.signal.reason = reason;
    this.listeners.forEach((fn) => fn());
  }
}

test('AbortSignal aborts a poll in progress', async () => {
  const controller = new FakeAbortController();
  const fetchStub = stubFetch([
    res(200, { status: 'RUNNING' }),
    res(200, { status: 'RUNNING' }),
  ]);
  const c = new HeimdallClient({ auth, fetch: fetchStub });
  const promise = c.waitForJob('job-5', {
    signal: controller.signal as any,
    intervalMs: 50,
  });
  setTimeout(() => controller.abort(new Error('user cancelled')), 5);
  await assert.rejects(() => promise, /user cancelled/);
});

// Directed: return_result must ALWAYS be set. spark-eks attaches results to the job
// only when it is present, so a missing flag yields a SUCCEEDED job with nothing to
// show -- a silent failure, which is why the invariant lives in one function.
test('sqlContext always sets return_result, and a caller cannot unset it', () => {
  assert.deepEqual(sqlContext('SELECT 1'), { query: 'SELECT 1', return_result: true });

  // Kyuubi's extra confs still ride along.
  assert.deepEqual(sqlContext('SELECT 1', { confs: { 'spark.x': '1' } }), {
    confs: { 'spark.x': '1' },
    query: 'SELECT 1',
    return_result: true,
  });

  // The whole point of spreading `extra` first: these must NOT win.
  assert.equal(sqlContext('SELECT 1', { return_result: false }).return_result, true);
  assert.equal(sqlContext('SELECT 1', { query: 'DROP TABLE t' }).query, 'SELECT 1');
});

// heimdall.serverUrl (extension.ts) does `setting.trim() || undefined` before handing baseUrl to
// the client, relying on the client's own trailing-slash strip rather than duplicating it.
test('a trailing slash on baseUrl is trimmed, and an empty/whitespace value falls back to the default', async () => {
  const calls: string[] = [];
  const fetchStub = async (url: string) => {
    calls.push(url);
    return res(200, { status: 'SUCCEEDED', id: '1' });
  };

  const withSlash = new HeimdallClient({ auth, baseUrl: 'https://example.test/', fetch: fetchStub as any });
  await withSlash.getJob('1');
  assert.equal(calls[0], 'https://example.test/api/v1/job/1');

  // Mirrors extension.ts: `'   '.trim() || undefined` yields undefined, so the client's own
  // default (HEIMDALL_BASE_URL) applies rather than a broken empty-string base.
  const withBlank = new HeimdallClient({ auth, baseUrl: '   '.trim() || undefined, fetch: fetchStub as any });
  await withBlank.getJob('1');
  assert.equal(calls[1], 'https://heimdall.aws.pattern.com/api/v1/job/1');
});
