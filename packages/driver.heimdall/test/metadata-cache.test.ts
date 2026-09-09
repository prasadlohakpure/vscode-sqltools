// Adapted from heimdall-vs-code-ext's test/metadata-cache.test.js — see UoW-03.
//
// Not a mechanical port: the fork's `MetadataCacheStore` takes an injected
// `CacheStorage` (read/write strings) rather than owning a file path itself —
// this driver has no `globalStorageUri` to write into (see
// src/explorer/metadataCache.ts's file header and NOTES.md). So this file
// swaps the reference's `{ dir }` + real-tempdir-file assertions for
// `MemoryCacheStorage`, and drops the file-path-specific assertions
// (`CACHE_FILE_NAME`, `cache.path`, `.tmp` atomic-write check) that have no
// equivalent surface here — noted inline below rather than invented.
//
// `kyuubiShowNamespaces`/`kyuubiShowTables` moved to `src/explorer/queries.ts`
// in the fork (metadataCache.ts imports them from there); everything else
// covered is the currently-exported surface named in UoW-03: readCache /
// writeCache / status / isRefreshDue / refresh / columnValues / columnIndex /
// formatAge.
import assert from 'assert';

import {
  DEFAULT_REFRESH_INTERVAL_MS,
  MemoryCacheStorage,
  MetadataCacheStore,
  columnIndex,
  columnValues,
  formatAge,
  isRefreshDue,
} from '../src/explorer/metadataCache';
import { kyuubiShowNamespaces, kyuubiShowTables } from '../src/explorer/queries';

const HOUR = 3_600_000;

function store(now?: () => number): { cache: MetadataCacheStore; storage: MemoryCacheStorage } {
  const storage = new MemoryCacheStorage();
  const cache = new MetadataCacheStore({ storage, now: now ?? (() => 1_000_000) });
  return { cache, storage };
}

/** `{columns, data}` the way Heimdall marshals it. */
function result(columns: string[], data: unknown[][]) {
  return { columns: columns.map((name) => ({ name, type: 'text' })), data };
}

/** Answers each SQL string from a table; anything unlisted is a zero-row `{}`. */
function fakeRunner(answers: Record<string, unknown>) {
  const seen: string[] = [];
  const run = async (sql: string) => {
    seen.push(sql);
    return answers[sql] ?? {};
  };
  (run as any).seen = seen;
  return run as typeof run & { seen: string[] };
}

test('write/read round-trip', () => {
  const { cache } = store();
  cache.writeCache({
    version: 1,
    targets: {
      kyuubi: { fetchedAt: 400_000, namespaces: { marketing: [] } },
    },
  });

  const read = cache.readCache();
  assert.deepEqual(read.targets.kyuubi, { fetchedAt: 400_000, namespaces: { marketing: [] } });

  const status = cache.status('kyuubi', read);
  assert.equal(status.fetchedAt, 400_000);
  assert.equal(status.namespaceCount, 1);
  assert.equal(status.tableCount, 0);
});

test('a missing cache (nothing ever written) degrades to empty and never throws', () => {
  const { cache } = store();
  assert.doesNotThrow(() => cache.readCache());
  assert.deepEqual(cache.readCache(), { version: 1, targets: {} });
  assert.equal(cache.status('kyuubi').label, 'never refreshed');
  assert.equal(cache.status('kyuubi').tableCount, 0);
});

test('a corrupt or foreign-version cache blob degrades to empty and never throws', () => {
  const { cache, storage } = store();
  storage.write('{"version":1,"targets":{"kyuubi"');
  assert.deepEqual(cache.readCache(), { version: 1, targets: {} });

  storage.write(JSON.stringify({ version: 99, targets: { kyuubi: { fetchedAt: 1, namespaces: {} } } }));
  assert.deepEqual(cache.readCache().targets, {}, 'a foreign format version is discarded, not migrated');

  storage.write(JSON.stringify({ version: 1, targets: { kyuubi: { namespaces: 'nope' } } }));
  assert.deepEqual(cache.readCache().targets, {}, 'a malformed target entry is dropped');
});

// Deliberately not ported: the reference's "cache file lives in the injected
// dir under a fixed name" and ".tmp file left behind" checks. Both assert on
// a real filesystem path (`cache.path`, `CACHE_FILE_NAME`) that doesn't exist
// in the fork's design — persistence is delegated to an injected
// `CacheStorage`, and `MemoryCacheStorage` (used here) never touches disk.
// See src/explorer/metadataCache.ts's file header ("no node:fs ... injected
// CacheStorage") and NOTES.md.

test('kyuubi refresh crawls namespaces in the injected catalog', async () => {
  const { cache } = store();
  const run = fakeRunner({
    [kyuubiShowNamespaces('glue_catalog')]: result(['namespace'], [['marketing'], ['finance']]),
    [kyuubiShowTables('glue_catalog', 'marketing')]: result(
      ['namespace', 'tableName', 'isTemporary'],
      [['marketing', 'spend', false]],
    ),
  });

  const entry = await cache.refresh('kyuubi', run);
  // finance answered `{}` — a zero-row result, which must parse to zero tables, not throw.
  assert.deepEqual(entry.namespaces, { marketing: ['spend'], finance: [] });
  assert.equal(run.seen[0], 'SHOW NAMESPACES IN `glue_catalog`');
  assert.equal(run.seen[1], 'SHOW TABLES IN `glue_catalog`.`marketing`');
});

test('a zero-row `{}` result parses to zero rows without throwing', () => {
  assert.deepEqual(columnValues({}, ['name']), []);
  assert.deepEqual(columnValues(undefined, ['name']), []);
  assert.deepEqual(columnValues({ columns: [{ name: 'name' }] }, ['name']), []);
  assert.deepEqual(columnValues(result(['name'], [['a'], [null], ['b']]), ['name']), ['a', 'b']);
});

test('columnIndex matches case-insensitively and returns -1 when absent', () => {
  const raw = result(['Namespace', 'TableName'], []);
  assert.equal(columnIndex(raw, ['tablename']), 1);
  assert.equal(columnIndex(raw, ['nope']), -1);
  assert.equal(columnIndex({}, ['name']), -1);
});

test('a failing top-level enumeration leaves the prior cache untouched', async () => {
  const { cache, storage } = store();
  const good = { version: 1, targets: { kyuubi: { fetchedAt: 500_000, namespaces: { marketing: ['spend'] } } } };
  cache.writeCache(good);
  const before = storage.read();

  // `SHOW NAMESPACES` itself fails: the crawl learned nothing, so this stays all-or-nothing.
  const run = async () => {
    throw new Error('job FAILED: insufficient privileges');
  };

  await assert.rejects(() => cache.refresh('kyuubi', run), /insufficient privileges/);
  assert.equal(storage.read(), before, 'a total failure must not rewrite the cache at all');
  assert.deepEqual(cache.readCache(), good);
});

test('one failing kyuubi namespace is skipped, keeps its cached tables, and marks the refresh stale', async () => {
  const { cache } = store();
  cache.writeCache({
    version: 1,
    targets: { kyuubi: { fetchedAt: 500_000, namespaces: { marketing: ['spend'], finance: ['ledger', 'gl'] } } },
  });

  const run = async (sql: string) => {
    if (sql === kyuubiShowNamespaces('glue_catalog')) {
      return result(['namespace'], [['marketing'], ['finance'], ['ops']]);
    }
    if (sql === kyuubiShowTables('glue_catalog', 'finance')) {
      throw new Error('job FAILED: insufficient privileges on finance');
    }
    return result(['namespace', 'tableName'], [['x', `${sql.slice(-10)}-t`]]);
  };

  const entry = await cache.refresh('kyuubi', run);
  assert.deepEqual(Object.keys(entry.namespaces).sort(), ['finance', 'marketing', 'ops']);
  assert.deepEqual(entry.namespaces.finance, ['ledger', 'gl'], 'the skipped namespace keeps its cached tables');
  assert.notDeepEqual(entry.namespaces.marketing, ['spend'], 'the healthy namespaces were re-crawled');
  assert.deepEqual(entry.staleNamespaces, ['finance']);

  const status = cache.status('kyuubi');
  assert.deepEqual(status.staleNamespaces, ['finance']);
  assert.equal(status.label, 'cached just now (1 not refreshed)', 'a partial refresh never reads as fully fresh');
  assert.deepEqual(cache.readCache().targets.kyuubi!.staleNamespaces, ['finance']);
});

test('an empty namespace and a failed namespace do not look the same', async () => {
  const { cache } = store();
  const run = async (sql: string) => (sql === kyuubiShowTables('glue_catalog', 'broken') ? Promise.reject(new Error('nope')) : {});
  const first = await cache.refresh('kyuubi', async (sql: string) =>
    sql === kyuubiShowNamespaces('glue_catalog') ? result(['namespace'], [['empty'], ['broken']]) : {},
  );
  assert.deepEqual(first, { fetchedAt: 1_000_000, namespaces: { empty: [], broken: [] } });
  assert.equal(first.staleNamespaces, undefined, 'an all-success refresh records no staleness');

  const second = await cache.refresh('kyuubi', async (sql: string) =>
    sql === kyuubiShowNamespaces('glue_catalog') ? result(['namespace'], [['empty'], ['broken']]) : run(sql),
  );
  // Both are `[]`, but only one is claimed as fresh.
  assert.deepEqual(second.staleNamespaces, ['broken']);
});

test('refresh-due policy inside and outside the window', () => {
  const fresh = { fetchedAt: 100 * HOUR, namespaces: {} };
  assert.equal(isRefreshDue(fresh, DEFAULT_REFRESH_INTERVAL_MS, 100 * HOUR + HOUR), false);
  assert.equal(isRefreshDue(fresh, DEFAULT_REFRESH_INTERVAL_MS, 100 * HOUR + 23 * HOUR), false);
  assert.equal(isRefreshDue(fresh, DEFAULT_REFRESH_INTERVAL_MS, 100 * HOUR + 24 * HOUR), true, 'boundary is due');
  assert.equal(isRefreshDue(fresh, DEFAULT_REFRESH_INTERVAL_MS, 100 * HOUR + 99 * HOUR), true);
  assert.equal(isRefreshDue(undefined), true, 'never refreshed is always due');
  assert.equal(isRefreshDue({ namespaces: {} } as any), true, 'a missing timestamp is always due');

  assert.equal(store().cache.isRefreshDue('kyuubi'), true, 'a target never refreshed is due');

  let clock = 100 * HOUR;
  const { cache } = store(() => clock);
  cache.writeCache({ version: 1, targets: { kyuubi: { fetchedAt: clock, namespaces: {} } } });
  assert.equal(cache.isRefreshDue('kyuubi'), false);
  clock += 25 * HOUR;
  assert.equal(cache.isRefreshDue('kyuubi'), true);
  assert.equal(cache.isRefreshDue('kyuubi', 30 * HOUR), false, "the interval is the caller's");
});

test('cache age is labelled honestly, never as fresh', () => {
  assert.equal(formatAge(undefined), 'never refreshed');
  assert.equal(formatAge(0), 'cached just now');
  assert.equal(formatAge(5 * 60_000), 'cached 5m ago');
  assert.equal(formatAge(3 * HOUR), 'cached 3h ago');
  assert.equal(formatAge(50 * HOUR), 'cached 2d ago');
  assert.equal(formatAge(0, 0), 'cached just now');
  assert.equal(formatAge(0, 2), 'cached just now (2 not refreshed)');
  assert.equal(formatAge(undefined, 1), 'never refreshed (1 not refreshed)');
});
