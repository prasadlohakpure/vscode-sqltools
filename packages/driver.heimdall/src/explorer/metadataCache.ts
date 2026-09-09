// Object-explorer metadata cache, ported from heimdall-vs-code-ext's
// `src/metadata-cache.ts` (FR-7 there). Same TTL/staleness semantics, adapted
// to run inside the SQLTools driver process instead of a VS Code extension
// host:
//
// - No `vscode` import (same as the source file) AND no `node:fs` either —
//   this driver doesn't own a `globalStorageUri`, so persistence is an
//   injected `CacheStorage` (read/write strings) the caller wires to whatever
//   this host gives it (a file under the LS's storage dir, or nothing at
//   all — `NullCacheStorage` below is a legitimate no-op for "don't persist,
//   just cache in memory for the process lifetime").
// - Everything else — cache shape, age formatting, staleNamespaces partial
//   refresh, isRefreshDue — is a straight port.

import { kyuubiShowNamespaces, kyuubiShowTables } from './queries';

export type TargetKind = 'kyuubi';

/** Bumped only if the on-disk shape changes; an older/newer file is discarded, not migrated. */
export const CACHE_FORMAT_VERSION = 1;

/** Namespace -> table names. Kyuubi keys are Spark namespaces (databases). */
export type NamespaceTables = Record<string, string[]>;

export interface TargetMetadata {
  /** Epoch ms of the refresh that produced this. Surfaced as cache age. */
  fetchedAt: number;
  namespaces: NamespaceTables;
  /**
   * Namespaces whose query failed during the last refresh, so their tables
   * are older than `fetchedAt`. Absent when the refresh was complete.
   */
  staleNamespaces?: string[];
}

export interface MetadataCacheFile {
  version: number;
  targets: { [K in TargetKind]?: TargetMetadata };
}

/** Runs one metadata statement (e.g. `SHOW TABLES IN ...`) and resolves the raw driver result. */
export type RunMetadataQuery = (sql: string) => Promise<unknown>;

/**
 * Injected persistence. `read` returns `undefined` when there is nothing
 * stored (first run, or storage unavailable) — never throws. `write` may
 * throw; callers should treat a failed write as "cache stays in-memory only
 * this run", not as a reason to fail the refresh that produced the data.
 */
export interface CacheStorage {
  read(): string | undefined;
  write(content: string): void;
}

/** In-memory only — nothing survives process restart. Fine when no on-disk slot exists. */
export class MemoryCacheStorage implements CacheStorage {
  private content: string | undefined;
  read(): string | undefined {
    return this.content;
  }
  write(content: string): void {
    this.content = content;
  }
}

export interface MetadataCacheOptions {
  storage: CacheStorage;
  /** Injectable clock, for tests and for the age calculation. */
  now?: () => number;
}

export interface RefreshOptions {
  /** Spark catalog to crawl, e.g. `glue_catalog`. */
  catalog?: string;
  /** Refuse to fan out past this many namespace queries. */
  maxNamespaces?: number;
}

/** One refresh is one query per namespace, so this bounds a runaway account. */
export const DEFAULT_MAX_NAMESPACES = 500;

/** Metadata moves in days, not minutes — matches the source extension's default. */
export const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const EMPTY_CACHE: MetadataCacheFile = { version: CACHE_FORMAT_VERSION, targets: {} };

// --- Result parsing (trust boundary) ---------------------------------------
//
// A zero-row driver result can marshal to `{}` or `{ columns: [], data: [] }`
// depending on the transport. Nothing below may throw on either shape.

interface RawResult {
  columns?: unknown;
  data?: unknown;
}

function rows(raw: unknown): unknown[][] {
  const data = (raw as RawResult | null | undefined)?.data;
  return Array.isArray(data) ? (data.filter((row) => Array.isArray(row)) as unknown[][]) : [];
}

/** Index of the first named column that exists, or -1. Names are matched case-insensitively. */
export function columnIndex(raw: unknown, candidates: string[]): number {
  const columns = (raw as RawResult | null | undefined)?.columns;
  if (!Array.isArray(columns)) {
    return -1;
  }
  const names = columns.map((column) => {
    if (typeof column === 'string') {
      return column.toLowerCase();
    }
    const name = (column as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name.toLowerCase() : '';
  });
  for (const candidate of candidates) {
    const found = names.indexOf(candidate.toLowerCase());
    if (found >= 0) {
      return found;
    }
  }
  return -1;
}

function cell(row: unknown[], index: number): string | undefined {
  const value = row[index];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Values of one column across every row. Zero rows -> `[]`.
 *
 * ponytail: falls back to column 0 when `columns` is absent but rows are not.
 * If this driver's wire format ever ships nameless columns for these
 * queries, pass an explicit index instead of guessing.
 */
export function columnValues(raw: unknown, candidates: string[]): string[] {
  const table = rows(raw);
  if (table.length === 0) {
    return [];
  }
  const index = Math.max(columnIndex(raw, candidates), 0);
  return table.map((row) => cell(row, index)).filter((value): value is string => value !== undefined);
}

// --- Cache age ---------------------------------------------------------

export interface TargetStatus {
  /** Epoch ms, or undefined when this target has never been refreshed. */
  fetchedAt?: number;
  ageMs?: number;
  /** Ready for a tree label. Never implies freshness it doesn't have. */
  label: string;
  namespaceCount: number;
  tableCount: number;
  /** Empty when the last refresh was complete. See `TargetMetadata.staleNamespaces`. */
  staleNamespaces: string[];
}

export function formatAge(ageMs: number | undefined, staleCount = 0): string {
  const age = formatAgeOnly(ageMs);
  if (staleCount <= 0) {
    return age;
  }
  return `${age} (${staleCount} not refreshed)`;
}

function formatAgeOnly(ageMs: number | undefined): string {
  if (ageMs === undefined) {
    return 'never refreshed';
  }
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) {
    return 'cached just now';
  }
  if (minutes < 60) {
    return `cached ${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `cached ${hours}h ago`;
  }
  return `cached ${Math.floor(hours / 24)}d ago`;
}

/** Refresh policy as pure logic, not a timer — the caller owns the interval. Never refreshed -> due. */
export function isRefreshDue(
  entry: TargetMetadata | undefined,
  intervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  now = Date.now(),
): boolean {
  if (!entry || typeof entry.fetchedAt !== 'number') {
    return true;
  }
  return now - entry.fetchedAt >= intervalMs;
}

// --- Store -----------------------------------------------------------------

export class MetadataCacheStore {
  private readonly storage: CacheStorage;
  private readonly now: () => number;

  constructor(options: MetadataCacheOptions) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
  }

  /** Never throws. A corrupt, absent, or foreign-version blob degrades to an empty cache. */
  readCache(): MetadataCacheFile {
    let raw: string | undefined;
    try {
      raw = this.storage.read();
    } catch {
      return { ...EMPTY_CACHE, targets: {} };
    }
    if (!raw) {
      return { ...EMPTY_CACHE, targets: {} };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...EMPTY_CACHE, targets: {} };
    }

    const file = parsed as MetadataCacheFile | null;
    if (!file || typeof file !== 'object' || file.version !== CACHE_FORMAT_VERSION) {
      return { ...EMPTY_CACHE, targets: {} };
    }

    const targets: MetadataCacheFile['targets'] = {};
    for (const target of ['kyuubi'] as TargetKind[]) {
      const entry = file.targets?.[target];
      if (!entry || typeof entry.fetchedAt !== 'number' || !entry.namespaces || typeof entry.namespaces !== 'object') {
        continue;
      }
      const namespaces: NamespaceTables = {};
      for (const [namespace, tables] of Object.entries(entry.namespaces)) {
        namespaces[namespace] = Array.isArray(tables) ? tables.filter((t) => typeof t === 'string') : [];
      }
      targets[target] = { fetchedAt: entry.fetchedAt, namespaces };
      if (Array.isArray(entry.staleNamespaces)) {
        targets[target]!.staleNamespaces = entry.staleNamespaces.filter((s) => typeof s === 'string');
      }
    }
    return { version: CACHE_FORMAT_VERSION, targets };
  }

  writeCache(cache: MetadataCacheFile): void {
    this.storage.write(JSON.stringify({ ...cache, version: CACHE_FORMAT_VERSION }));
  }

  status(target: TargetKind, cache = this.readCache()): TargetStatus {
    const entry = cache.targets[target];
    if (!entry) {
      return { label: formatAge(undefined), namespaceCount: 0, tableCount: 0, staleNamespaces: [] };
    }
    const namespaces = Object.values(entry.namespaces);
    const ageMs = Math.max(0, this.now() - entry.fetchedAt);
    const stale = entry.staleNamespaces ?? [];
    return {
      fetchedAt: entry.fetchedAt,
      ageMs,
      label: formatAge(ageMs, stale.length),
      namespaceCount: namespaces.length,
      tableCount: namespaces.reduce((total, tables) => total + tables.length, 0),
      staleNamespaces: stale,
    };
  }

  isRefreshDue(target: TargetKind, intervalMs = DEFAULT_REFRESH_INTERVAL_MS, cache = this.readCache()): boolean {
    return isRefreshDue(cache.targets[target], intervalMs, this.now());
  }

  /**
   * Run the `SHOW`-style population queries (see `queries.ts`) for one target
   * and replace that target's entry.
   *
   * Same two failure classes as the source extension:
   * - one namespace's `SHOW TABLES` fails -> skipped, keeps its previous
   *   tables, and is listed in `staleNamespaces`.
   * - the top-level `SHOW NAMESPACES` fails -> nothing was learned, throws,
   *   previous cache is left untouched.
   */
  async refresh(target: TargetKind, runQuery: RunMetadataQuery, options: RefreshOptions = {}): Promise<TargetMetadata> {
    const { namespaces, failed } = await crawlKyuubi(runQuery, options);

    const cache = this.readCache();
    const previous = cache.targets[target]?.namespaces ?? {};
    for (const scope of failed) {
      if (scope in previous) {
        namespaces[scope] = previous[scope];
      }
    }

    const entry: TargetMetadata = { fetchedAt: this.now(), namespaces };
    if (failed.length > 0) {
      entry.staleNamespaces = failed;
    }
    cache.targets[target] = entry;
    this.writeCache(cache);
    return entry;
  }
}

// --- Population queries ------------------------------------------------

interface CrawlResult {
  namespaces: NamespaceTables;
  /** Namespaces whose query threw and were skipped. See `TargetMetadata.staleNamespaces`. */
  failed: string[];
}

async function crawlKyuubi(runQuery: RunMetadataQuery, options: RefreshOptions): Promise<CrawlResult> {
  const catalog = options.catalog ?? 'glue_catalog';
  const limit = options.maxNamespaces ?? DEFAULT_MAX_NAMESPACES;
  // Not caught: without the namespace list the crawl learned nothing at all.
  const found = columnValues(await runQuery(kyuubiShowNamespaces(catalog)), ['namespace', 'name']);

  const namespaces: NamespaceTables = {};
  const failed: string[] = [];
  for (const namespace of found.slice(0, limit)) {
    try {
      namespaces[namespace] = columnValues(await runQuery(kyuubiShowTables(catalog, namespace)), [
        'tableName',
        'table_name',
        'name',
      ]);
    } catch {
      failed.push(namespace);
    }
  }
  return { namespaces, failed };
}
