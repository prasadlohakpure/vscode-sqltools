// Self-check for the capture ring buffer, run as a plain node script
// (`node out-test/test/capture.test.js`) — no test-runner dependency needed,
// and it avoids requiring @types/node new enough to type `node:test`.
import assert from 'assert';
import { ResultCapture, HOOKED_COMMANDS } from '../capture';

const tests: { [name: string]: () => void } = {};
function test(name: string, fn: () => void) {
  tests[name] = fn;
}

function fakeExtension() {
  const before: { [c: string]: Function[] } = {};
  const after: { [c: string]: Function[] } = {};
  return {
    addBeforeCommandHook(cmd: string, h: Function) {
      (before[cmd] ||= []).push(h);
      return this;
    },
    addAfterCommandSuccessHook(cmd: string, h: Function) {
      (after[cmd] ||= []).push(h);
      return this;
    },
    fire: {
      before: (cmd: string, evt: any) => before[cmd].forEach(h => h(evt)),
      after: (cmd: string, evt: any) => after[cmd].forEach(h => h(evt)),
    },
  } as any;
}

test('ResultCapture records a success entry with duration/rowCount/status', () => {
  const capture = new ResultCapture();
  const ext = fakeExtension();
  capture.register(ext);

  ext.fire.before('executeQuery', { command: 'executeQuery', args: [] });
  ext.fire.after('executeQuery', {
    command: 'executeQuery',
    args: [],
    result: [{ connId: 'conn1|mysql|host|db', query: 'select 1', cols: ['a'], results: [{ a: 1 }] }],
  });

  const latest = capture.getLatest();
  assert.ok(latest);
  assert.equal(latest!.status, 'success');
  assert.equal(latest!.rowCount, 1);
  assert.equal(latest!.connectionName, 'conn1');
  assert.equal(typeof latest!.durationMs, 'number');
});

test('ResultCapture marks a result with `error` as status error', () => {
  const capture = new ResultCapture();
  const ext = fakeExtension();
  capture.register(ext);

  ext.fire.before('executeQuery', { command: 'executeQuery', args: [] });
  ext.fire.after('executeQuery', {
    command: 'executeQuery',
    args: [],
    result: [{ connId: 'conn1|mysql|host|db', query: 'bad sql', error: 'syntax error' }],
  });

  assert.equal(capture.getLatest()!.status, 'error');
});

test('ResultCapture ring buffer caps at 100 entries, newest first', () => {
  const capture = new ResultCapture();
  const ext = fakeExtension();
  capture.register(ext);

  for (let i = 0; i < 105; i++) {
    ext.fire.before('executeQuery', { command: 'executeQuery', args: [] });
    ext.fire.after('executeQuery', {
      command: 'executeQuery',
      args: [],
      result: [{ connId: 'c', query: `select ${i}`, cols: [], results: [] }],
    });
  }

  const entries = capture.getEntries();
  assert.equal(entries.length, 100);
  assert.equal(entries[0].query, 'select 104');
});

test('all three hooked commands are wired', () => {
  assert.deepEqual(HOOKED_COMMANDS, ['executeQuery', 'executeCurrentQuery', 'executeQueryFromFile']);
});

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(e);
  }
}
if (failed > 0) {
  console.error(`${failed}/${Object.keys(tests).length} tests failed`);
  process.exit(1);
}
console.log(`${Object.keys(tests).length} tests passed`);
