// No framework, no mocking library — catalog fixtures are plain objects.
// Ported from heimdall-vs-code-ext's test/targets.test.js — see UoW-03.
import assert from 'assert';

import {
  DEFAULT_TARGET_ID,
  TARGETS,
  TargetResolutionError,
  effectiveTarget,
  resolveTarget,
  resolveTargets,
  targetById,
  targetSummary,
  verifyResolvedTarget,
} from '../src/heimdall/targets';

const kyuubi = targetById('kyuubi')!;
const sparkEks = targetById('spark-eks')!;

/** `assert.throws` returns undefined, and these assertions are about the error's fields. */
function caught(fn: () => unknown): TargetResolutionError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TargetResolutionError, `expected TargetResolutionError, got ${error}`);
    return error as TargetResolutionError;
  }
  assert.fail('expected a TargetResolutionError, nothing was thrown');
}

// Fixtures mirror heimdall.yaml.tmpl, including the system tags Object.Init()
// appends (`_name:`, `_version:`) and the wire-format uppercase status.
const commands = [
  {
    name: 'kyuubi-adhoc-0.0.1',
    version: '0.0.1',
    status: 'ACTIVE',
    tags: ['type:kyuubi', '_name:kyuubi-adhoc-0.0.1', '_version:0.0.1'],
    cluster_tags: ['type:kyuubi'],
  },
  {
    name: 'trino-475',
    version: '475',
    status: 'ACTIVE',
    tags: ['type:trino'],
    cluster_tags: ['type:trino'],
  },
  {
    name: 'spark-eks-sql-3.5.6',
    version: '3.5.6',
    status: 'ACTIVE',
    tags: ['type:sparksql-eks'],
    cluster_tags: ['type:spark-eks'],
  },
  {
    // The verified trap: same k8s cluster_name `spark-eks` underneath both
    // Spark commands, but this one's own cluster_tags point at the separate
    // Heimdall cluster `spark-4.1.1`, not `spark-eks`. Different command
    // criteria too, so it never competes with the batch target's resolution.
    name: 'spark-sql-4.1.1',
    version: '4.1.1',
    status: 'ACTIVE',
    tags: ['type:sparksql-eks-4.1.1'],
    cluster_tags: ['type:spark-4.1.1'],
  },
];

const clusters = [
  { name: 'kyuubi-adhoc', version: '0.0.1', status: 'ACTIVE', tags: ['type:kyuubi', 'data:prod'] },
  { name: 'eks-trino-475', version: '475', status: 'ACTIVE', tags: ['type:trino', 'data:prod'] },
  { name: 'spark-eks', version: '3.5.6', status: 'ACTIVE', tags: ['type:spark-eks', 'data:prod'] },
  // Separate cluster the 4.1.1 command's own cluster_tags actually resolve to
  // — NOT `spark-eks`, despite sharing its k8s cluster_name underneath.
  { name: 'spark-4.1.1', version: '4.1.1', status: 'ACTIVE', tags: ['type:spark-4.1.1', 'data:prod'] },
];

// --- Happy path -------------------------------------------------------------

test('the table is exactly the two in-scope targets', () => {
  assert.deepEqual(
    TARGETS.map((t) => t.id),
    ['kyuubi', 'spark-eks'],
  );
  assert.equal(targetById(DEFAULT_TARGET_ID)?.id, 'kyuubi');
  assert.equal(targetById(DEFAULT_TARGET_ID)?.latency, 'interactive');
  assert.equal(targetById('trino'), undefined);
  assert.equal(targetById('snowflake'), undefined, 'Snowflake is removed, not just parked');
});

test('each target resolves to exactly one command/cluster pair', () => {
  const ky = resolveTarget(kyuubi, commands, clusters);
  assert.equal(ky.command.name, 'kyuubi-adhoc-0.0.1');
  assert.equal(ky.cluster.name, 'kyuubi-adhoc');
});

test('spark-eks resolves to exactly one command/cluster pair, not the 4.1.1 trap', () => {
  const batch = resolveTarget(sparkEks, commands, clusters);
  assert.equal(batch.command.name, 'spark-eks-sql-3.5.6');
  assert.equal(batch.cluster.name, 'spark-eks');
  assert.notEqual(batch.cluster.name, 'spark-4.1.1');
  assert.equal(sparkEks.latency, 'batch-cold-start');
});

test('resolveTargets validates both targets and reports per-target', () => {
  const results = resolveTargets(commands, clusters);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(
    results.map((r) => (r as { ok: true; cluster: { name: string } }).cluster.name),
    ['kyuubi-adhoc', 'spark-eks'],
  );
});

// --- The point of this unit: dropping `data:prod` must be rejected ----------

test('broadened spark-eks criteria without data:prod is ambiguous, not silently picked', () => {
  // A future `spark-eks-dev` tagged `type:spark-eks` shows up in the catalog —
  // exactly the scenario `data:prod` on the real row guards against.
  const withDevCluster = [
    ...clusters,
    { name: 'spark-eks-dev', version: '3.5.6', status: 'ACTIVE', tags: ['type:spark-eks', 'data:local'] },
  ];
  const broadened = { ...sparkEks, clusterCriteria: ['type:spark-eks'] };
  const err = caught(() => resolveTarget(broadened, commands, withDevCluster));
  assert.equal(err.kind, 'ambiguous');
  assert.deepEqual(err.pairs, [
    'spark-eks-sql-3.5.6@spark-eks',
    'spark-eks-sql-3.5.6@spark-eks-dev',
  ]);

  // The real row, with data:prod intact, still resolves uniquely against the
  // same catalog.
  const stillUnique = resolveTarget(sparkEks, commands, withDevCluster);
  assert.equal(stillUnique.cluster.name, 'spark-eks');
});

// --- Zero pairs -------------------------------------------------------------

test('no matching command -> unavailable error naming the command criteria', () => {
  const err = caught(() =>
    resolveTarget(kyuubi, commands.filter((c) => c.name !== 'kyuubi-adhoc-0.0.1'), clusters),
  );
  assert.equal(err.kind, 'unavailable');
  assert.equal(err.targetId, 'kyuubi');
  assert.match(err.message, /no active Heimdall command has tags \[type:kyuubi\]/);
});

test('an inactive command counts as missing', () => {
  const withInactive = commands.map((c) =>
    c.name === 'kyuubi-adhoc-0.0.1' ? { ...c, status: 'INACTIVE' } : c,
  );
  const err = caught(() => resolveTarget(kyuubi, withInactive, clusters));
  assert.equal(err.kind, 'unavailable');
});

test('no matching cluster -> unavailable error naming the command found and the cluster tags needed', () => {
  const err = caught(() =>
    resolveTarget(kyuubi, commands, clusters.filter((c) => c.name !== 'kyuubi-adhoc')),
  );
  assert.equal(err.kind, 'unavailable');
  assert.match(err.message, /kyuubi-adhoc-0\.0\.1 matched/);
  assert.match(err.message, /no active cluster has tags \[type:kyuubi, data:prod\]/);
});

test('an inactive cluster counts as missing', () => {
  const withInactive = clusters.map((c) =>
    c.name === 'kyuubi-adhoc' ? { ...c, status: 'DELETED' } : c,
  );
  const err = caught(() => resolveTarget(kyuubi, commands, withInactive));
  assert.equal(err.kind, 'unavailable');
});

// --- Two pairs: the one that must never become a silent pick ----------------

test('two matching clusters -> error, NOT a random pick', () => {
  // A second prod Kyuubi cluster appears — exactly the shape job.go resolves
  // with rand.Int. This is the ambiguity precedent `data:prod` on the real
  // row exists to guard against (see the TARGETS comment in src/heimdall/targets.ts).
  const ambiguous = [
    ...clusters,
    { name: 'kyuubi-adhoc-2', status: 'ACTIVE', tags: ['type:kyuubi', 'data:prod'] },
  ];
  const err = caught(() => resolveTarget(kyuubi, commands, ambiguous));
  assert.equal(err.kind, 'ambiguous');
  assert.deepEqual(err.pairs, [
    'kyuubi-adhoc-0.0.1@kyuubi-adhoc',
    'kyuubi-adhoc-0.0.1@kyuubi-adhoc-2',
  ]);
  assert.match(err.message, /at random/);
});

test('two matching commands -> error, NOT a random pick', () => {
  const ambiguous = [
    ...commands,
    { name: 'kyuubi-adhoc-0.0.2', status: 'ACTIVE', tags: ['type:kyuubi'], cluster_tags: ['type:kyuubi'] },
  ];
  const err = caught(() => resolveTarget(kyuubi, ambiguous, clusters));
  assert.equal(err.kind, 'ambiguous');
  assert.equal(err.pairs.length, 2);
});

test('resolveTargets surfaces one ambiguous target without hiding the healthy one', () => {
  const ambiguous = [
    ...clusters,
    { name: 'kyuubi-adhoc-2', status: 'ACTIVE', tags: ['type:kyuubi', 'data:prod'] },
  ];
  const [ky, batch] = resolveTargets(commands, ambiguous);
  assert.equal(ky.ok, false);
  assert.equal((ky as { ok: false; error: TargetResolutionError }).error.kind, 'ambiguous');
  assert.equal(batch.ok, true);
  assert.equal((batch as { ok: true; cluster: { name: string } }).cluster.name, 'spark-eks');
});

// --- The command's own cluster_tags -----------------------------------------

test("a cluster failing the command's own cluster_tags is not a pair", () => {
  // Criteria alone would match, but the command demands `type:kyuubi` too.
  const strict = [{ ...commands[0], cluster_tags: ['type:kyuubi', 'zone:us-west-2'] }];
  assert.equal(caught(() => resolveTarget(kyuubi, strict, clusters)).kind, 'unavailable');

  const tagged = [...clusters, { name: 'kyuubi-adhoc-wz', status: 'ACTIVE', tags: ['type:kyuubi', 'data:prod', 'zone:us-west-2'] }];
  assert.equal(resolveTarget(kyuubi, strict, tagged).cluster.name, 'kyuubi-adhoc-wz');
});

// --- Post-submit verification -----------------------------------------------

test('verifyResolvedTarget: match', () => {
  const resolved = resolveTarget(kyuubi, commands, clusters);
  const v = verifyResolvedTarget(resolved, {
    command_name: 'kyuubi-adhoc-0.0.1',
    cluster_name: 'kyuubi-adhoc',
  });
  assert.equal(v.state, 'match');
  assert.equal(v.message, undefined);
});

test('verifyResolvedTarget: mismatch is loud and names both sides', () => {
  const resolved = resolveTarget(kyuubi, commands, clusters);
  const v = verifyResolvedTarget(resolved, {
    command_name: 'kyuubi-adhoc-0.0.1',
    cluster_name: 'kyuubi-adhoc-2',
  });
  assert.equal(v.state, 'mismatch');
  assert.match(v.message!, /kyuubi-adhoc/);
  assert.match(v.message!, /kyuubi-adhoc-2/);
  assert.equal(v.actual.cluster, 'kyuubi-adhoc-2');
});

test('verifyResolvedTarget: absent fields are unverified, never mismatch', () => {
  const resolved = resolveTarget(kyuubi, commands, clusters);
  for (const response of [{}, undefined, { command_name: '', cluster_name: '' }]) {
    const v = verifyResolvedTarget(resolved, response);
    assert.equal(v.state, 'unverified');
    assert.match(v.message!, /not verified/);
  }
  // One field present and correct, the other absent is still unverified.
  const partial = verifyResolvedTarget(resolved, { command_name: 'kyuubi-adhoc-0.0.1' });
  assert.equal(partial.state, 'unverified');
  assert.match(partial.message!, /cluster_name/);
  // ...but one field present and WRONG is a mismatch even if the other is absent.
  const wrong = verifyResolvedTarget(resolved, { cluster_name: 'spark-eks' });
  assert.equal(wrong.state, 'mismatch');
});

// --- Per-worksheet selection ------------------------------------------------

test('per-document override beats the workspace default', () => {
  const selection = {
    default: 'spark-eks',
    overrides: { 'file:///w/etl.sql': 'kyuubi' },
  };
  assert.equal(effectiveTarget(selection, 'file:///w/etl.sql').id, 'kyuubi');
  assert.equal(effectiveTarget(selection, 'file:///w/other.sql').id, 'spark-eks');
  assert.equal(effectiveTarget(selection, undefined).id, 'spark-eks');
});

test('workspace default applies with no override, and junk falls through', () => {
  assert.equal(effectiveTarget({ default: 'kyuubi' }, 'file:///w/a.sql').id, 'kyuubi');
  assert.equal(effectiveTarget(undefined, 'file:///w/a.sql').id, DEFAULT_TARGET_ID);
  assert.equal(effectiveTarget({ default: 'trino' }, 'file:///w/a.sql').id, DEFAULT_TARGET_ID);
  // spark-eks is a real target now (UoW-18), so an override naming it wins.
  assert.equal(
    effectiveTarget({ default: 'kyuubi', overrides: { 'file:///w/a.sql': 'spark-eks' } }, 'file:///w/a.sql').id,
    'spark-eks',
  );
  // A genuinely unrecognised id still falls through.
  assert.equal(
    effectiveTarget({ default: 'kyuubi', overrides: { 'file:///w/a.sql': 'trino' } }, 'file:///w/a.sql').id,
    'kyuubi',
  );
});

// --- Display copy (the sidebar Target panel + the status bar share this) ----
//
// One derivation for both, so the panel and the status bar cannot describe the
// same resolution differently. The FR-1.3 line that matters: `error` (a real
// ambiguous/unavailable failure) and `unverified` (nothing was checked) must
// never collapse into each other.

test('a resolved target summarises as the command/cluster pair it resolved to', () => {
  const s = targetSummary(kyuubi, {
    ok: true,
    target: kyuubi,
    command: { name: 'kyuubi-adhoc-0.0.1', tags: [] },
    cluster: { name: 'kyuubi-adhoc', tags: [] },
  });
  assert.equal(s.state, 'ok');
  assert.equal(s.label, kyuubi.label, 'an interactive target carries no badge');
  assert.equal(s.detail, 'kyuubi-adhoc-0.0.1 → kyuubi-adhoc');
  assert.equal(s.tooltip, s.detail);
});

test('FR-1.6: the cold-start target is badged wherever it is displayed', () => {
  const s = targetSummary(sparkEks, undefined);
  assert.match(s.label, /\(batch, cold start\)$/);
  // And the badge is on the resolved rendering too, not only the degraded one.
  const resolved = targetSummary(sparkEks, {
    ok: true,
    target: sparkEks,
    command: { name: 'spark-eks-sql-3.5.6', tags: [] },
    cluster: { name: 'spark-eks', tags: [] },
  });
  assert.match(resolved.label, /\(batch, cold start\)$/);
});

test('FR-1.3: a failed resolution reports the real error, never a working pair', () => {
  const error = new TargetResolutionError('ambiguous', kyuubi, 'two clusters match [type:kyuubi]', [
    'kyuubi-adhoc-0.0.1@kyuubi-adhoc',
    'kyuubi-adhoc-0.0.1@kyuubi-adhoc-dev',
  ]);
  const s = targetSummary(kyuubi, { ok: false, target: kyuubi, error });
  assert.equal(s.state, 'error');
  assert.equal(s.detail, 'unavailable');
  assert.equal(s.tooltip, 'two clusters match [type:kyuubi]', 'the actionable message must survive');
});

test('an unvalidated target is "not verified", and offline says why — not "unavailable"', () => {
  const starting = targetSummary(kyuubi, undefined);
  assert.equal(starting.state, 'unverified');
  assert.equal(starting.detail, 'not verified');
  assert.match(starting.tooltip, /not verified yet/);

  const offline = targetSummary(kyuubi, undefined, 'Heimdall targets could not be verified: fetch failed');
  assert.equal(offline.state, 'unverified', 'offline is ignorance, not a resolution failure');
  assert.equal(offline.tooltip, 'Heimdall targets could not be verified: fetch failed');
  assert.notEqual(offline.detail, 'unavailable', 'must not read as a broken target');
});
