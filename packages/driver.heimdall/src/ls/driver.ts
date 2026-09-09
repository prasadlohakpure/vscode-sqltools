import { readFileSync } from 'fs';
import AbstractDriver from '@sqltools/base-driver';
import {
  IConnectionDriver,
  IBaseQueries,
  NSDatabase,
  IQueryOptions,
  IExpectedResult,
  IConnection,
  LSIConnection,
  ContextValue,
  MConnectionExplorer,
  Arg0,
} from '@sqltools/types';
import { parse as queryParse } from '@sqltools/util/query';
import generateId from '@sqltools/util/internal-id';
import { HeimdallClient, HeimdallAuth, sqlContext, QueryResult } from '../heimdall/client';
import {
  TARGETS,
  resolveTarget,
  verifyResolvedTarget,
  targetById,
  DEFAULT_TARGET_ID,
  TargetResolutionError,
  CatalogItem,
} from '../heimdall/targets';
import { cookieFileCandidates, buildCookieHeader, cookieAgeDays, COOKIE_MAX_AGE_DAYS } from '../heimdall/auth';
import { isReadOnly, isSessionStatement, injectLimit } from '../heimdall/safety';
import { annotateResult } from '../results/annotate';
import explorerQueries, { quoteSpark, kyuubiShowNamespaces, kyuubiShowTables } from '../explorer/queries';
import { MetadataCacheStore, MemoryCacheStorage, columnValues, CACHE_FORMAT_VERSION, NamespaceTables } from '../explorer/metadataCache';
import { MetadataRequestResult, TARGET_MISMATCH, TargetMismatchParams } from '../ipc';

/** Mirrors `safety.ts`'s own fallback (not exported — see that file's header note on why). */
const DEFAULT_MAX_ROWS = 1000;

export interface IHeimdallConnectionOptions {
  name: string;
  target: string;
  authMode: 'service-token' | 'cookie-file';
  /** Only used in `service-token` mode; `cookie-file` reads the Gatekeeper file automatically. */
  authHeader?: string;
}

function q<R = any>(query: string): IExpectedResult<R> {
  return query as any;
}

export default class HeimdallDriver extends AbstractDriver<HeimdallClient, IHeimdallConnectionOptions> implements IConnectionDriver {

  /**
   * UoW-02: `src/ls/plugin.ts`'s `REFRESH_METADATA`/`CLEAR_METADATA` handlers
   * arrive keyed by `connId` (see `../ipc.ts`), but the LS's own
   * `LSContextMap.drivers` only maps driver *type* -> class, not the live
   * per-connection instance. This registry is that missing lookup, populated
   * additively in the constructor below.
   *
   * ponytail: entries are never deleted on `close()` (that method's body is
   * fenced — live-verified, additive-only). A reconnect overwrites the same
   * connId key, so this never grows past "one entry per distinct connection
   * ever opened this LS process lifetime" — bounded and harmless. Upgrade
   * path: a `close()` follow-up once that method is unfenced.
   */
  private static readonly instances = new Map<string, HeimdallDriver>();

  static getInstance(connId: string): HeimdallDriver | undefined {
    return HeimdallDriver.instances.get(connId);
  }

  /**
   * UoW-05: the LS `server` handed in by `ls/plugin.ts`'s `register(server)`
   * — the only thing this class needs from it is `sendNotification`, so the
   * type is kept to that rather than importing SQLTools' full LS server type
   * into this file.
   */
  private static server: { sendNotification(method: string, params: unknown): void } | undefined;

  static setServer(server: { sendNotification(method: string, params: unknown): void }): void {
    HeimdallDriver.server = server;
  }

  /** Additive: registers this instance for the IPC lookup above. */
  constructor(credentials: IConnection<IHeimdallConnectionOptions>, getWorkspaceFolders: LSIConnection['workspace']['getWorkspaceFolders']) {
    super(credentials, getWorkspaceFolders);
    HeimdallDriver.instances.set(this.getId(), this);
  }

  /** Spark catalog crawled by the object explorer. Matches `metadataCache.ts`'s own default. */
  private static readonly CATALOG = 'glue_catalog';

  /** In-process only (FR-4/5) — no `globalStorageUri` on this driver, see `explorer/NOTES.md`. */
  private readonly metadataCache = new MetadataCacheStore({ storage: new MemoryCacheStorage() });

  queries: IBaseQueries = {
    ...explorerQueries,
    fetchRecords: ({ table, limit, offset }) => q(`SELECT * FROM ${table.label} LIMIT ${limit} OFFSET ${offset}`),
    countRecords: ({ table }) => q(`SELECT COUNT(1) AS total FROM ${table.label}`),
    // ponytail: single-table DESCRIBE, not a cross-table column search — Spark
    // has no reliable INFORMATION_SCHEMA.COLUMNS across Kyuubi/Hive-metastore
    // versions the way driver.pg's searchColumns leans on Postgres's. Ceiling:
    // searching across multiple tables at once returns only the first table's
    // columns. Upgrade path is a UNION ALL of DESCRIBE per table, once someone
    // actually needs multi-table column search in the explorer.
    searchColumns: ({ tables }) =>
      q(tables[0] ? `DESCRIBE ${quoteSpark(`${tables[0].schema}.${tables[0].label}`)}` : 'SELECT 1'),
  };

  /**
   * `cookie-file` mode reads the same Gatekeeper cookie chain as the VS Code
   * extension (`heimdall-vs-code-ext/src/auth.ts` `resolveAuth`'s cookie
   * branch) — never typed in, so the connection form's `authHeader` box is
   * hidden entirely for this mode (see `connection.schema.json`). `resolveAuth`
   * itself isn't called directly here: it tries `PATTERN__HEIMDALL_TOKEN`
   * first regardless of mode, which would silently override a user's explicit
   * "use my cookie file" choice in this UI — so the cookie lookup is inlined
   * from `auth.ts`'s exported primitives instead.
   */
  private buildAuth(): HeimdallAuth {
    const { authMode, authHeader } = this.credentials;

    if (authMode === 'cookie-file') {
      for (const path of cookieFileCandidates()) {
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
          throw new Error(`${path} is not valid JSON. Re-create it: run \`mise run agent-sandbox:auth\` in the data-airflow repo.`);
        }
        const cookie = buildCookieHeader(parsed.cookies ?? {});
        if (!cookie) {
          throw new Error(`${path} has no .cookies entries. Run \`mise run agent-sandbox:auth\` in the data-airflow repo.`);
        }
        const age = typeof parsed.when_created === 'number' ? cookieAgeDays(parsed.when_created) : undefined;
        if (age !== undefined && age > COOKIE_MAX_AGE_DAYS) {
          this.log.warn(`Gatekeeper cookies in ${path} are ${age.toFixed(1)} days old (stale after ~${COOKIE_MAX_AGE_DAYS}). Queries will likely fail — run \`mise run agent-sandbox:auth\` in the data-airflow repo.`);
        }
        return { headers: { Cookie: cookie }, mode: 'cookie-file', source: path };
      }
      throw new Error(
        `No Gatekeeper cookie file found at: ${cookieFileCandidates().join(', ')}. ` +
          'Run `mise run agent-sandbox:auth` in the data-airflow repo, or switch this connection to service-token mode.',
      );
    }

    // service-token: an explicit value in the connection form wins; otherwise
    // fall back to the same env var the VS Code extension reads.
    const token = (authHeader ?? process.env.PATTERN__HEIMDALL_TOKEN ?? '').trim();
    if (!token) {
      throw new Error('Auth mode is "service-token" but no token was entered and PATTERN__HEIMDALL_TOKEN is not set.');
    }
    return {
      headers: { 'X-Pattern-Service': token },
      mode: 'service-token',
      source: authHeader ? 'connection settings' : 'env PATTERN__HEIMDALL_TOKEN',
    };
  }

  private getTarget() {
    const target = targetById(this.credentials.target) ?? targetById(DEFAULT_TARGET_ID) ?? TARGETS[0];
    return target;
  }

  public async open() {
    if (this.connection) {
      return this.connection;
    }
    const client = new HeimdallClient({ auth: this.buildAuth() });
    this.connection = Promise.resolve(client);
    return this.connection;
  }

  public async close() {
    // stateless HTTP client — nothing to tear down.
    this.connection = null;
  }

  public async testConnection() {
    const client = await this.open();
    const [commands, clusters] = await Promise.all([client.listCommands(), client.listClusters()]);
    try {
      resolveTarget(this.getTarget(), commands.data as CatalogItem[], clusters.data as CatalogItem[]);
    } catch (error) {
      if (error instanceof TargetResolutionError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }

  public query: (typeof AbstractDriver)['prototype']['query'] = async (query, opt: IQueryOptions = {}) => {
    const client = await this.open();
    const { requestId } = opt;
    const target = this.getTarget();
    const [commands, clusters] = await Promise.all([client.listCommands(), client.listClusters()]);
    const resolved = resolveTarget(target, commands.data as CatalogItem[], clusters.data as CatalogItem[]);

    const statements = queryParse(query.toString()).filter(Boolean);
    const resultsAgg: NSDatabase.IResult[] = [];
    for (const rawStatement of statements) {
      const warnings: string[] = [];
      let sql = rawStatement;

      // FR-6.2/6.3 safety rails (see heimdall/safety.ts's header for why this
      // is enforced client-side at all). NOTE — no pre-execute confirmation
      // gate exists in this architecture: SQLTools' driver contract has no
      // veto hook, so a non-read-only statement below already ran by the time
      // this warning is attached. See results/NOTES.md for the full
      // regression writeup; a real fix needs a command-layer wrapper around
      // `sqltools.executeQuery`, not anything this file can do alone.
      if (!isReadOnly(sql)) {
        warnings.push(
          'Not read-only (write/DDL/unrecognised statement) — this ran with no confirmation step; ' +
            'SQLTools drivers have no pre-execute veto hook. See driver.heimdall/src/results/NOTES.md.',
        );
      } else if (isSessionStatement(sql)) {
        warnings.push(
          'USE/SET/ALTER SESSION only affects this job — every job gets a fresh session (FR-8), ' +
            'so this has no effect beyond the statement that ran it.',
        );
      } else {
        sql = injectLimit(sql, DEFAULT_MAX_ROWS);
      }

      const { job, result } = await client.runJob({
        name: 'sqltools-heimdall-query',
        version: resolved.command.version ?? '0.0.1',
        context: sqlContext(sql),
        command_criteria: target.commandCriteria,
        cluster_criteria: target.clusterCriteria,
      });

      const verification = verifyResolvedTarget(resolved, job);
      if (verification.state === 'mismatch') {
        warnings.push(verification.message!);
        // US-2/FR-2: also push a notification the ext host can turn into a
        // real, un-scrollable-past `showErrorMessage` — the `messages` entry
        // above is easy to miss inline in the results grid. `unverified`
        // deliberately does not reach here (messages-only, matches the
        // reference extension — don't cry wolf on "couldn't confirm").
        HeimdallDriver.server?.sendNotification(TARGET_MISMATCH, <TargetMismatchParams>{
          message: verification.message!,
          expected: verification.expected,
          actual: verification.actual,
        });
      }

      resultsAgg.push(<NSDatabase.IResult>{
        requestId,
        resultId: generateId(),
        connId: this.getId(),
        query: sql,
        ...annotateResult(result, warnings),
      });
    }
    return resultsAgg;
  }

  // --- UoW-02: object explorer, backed by the metadata cache ---------------
  //
  // Additive-only from here down — `open`/`close`/`testConnection`/`query`
  // above are untouched. Runs metadata `SHOW`/`DESCRIBE` statements directly
  // against `client.runJob` (mirroring `query()`'s job-submission shape)
  // instead of routing through `this.query()`, because the cache's
  // `RunMetadataQuery`/`columnValues` contract (`explorer/metadataCache.ts`)
  // needs the raw `{ columns, data }` `QueryResult`, not `query()`'s
  // annotated/record-shaped `NSDatabase.IResult`.

  /** One Heimdall job for one metadata statement (`SHOW ...`/`DESCRIBE ...`). */
  private async runMetadataQuery(sql: string): Promise<QueryResult> {
    const client = await this.open();
    const target = this.getTarget();
    const [commands, clusters] = await Promise.all([client.listCommands(), client.listClusters()]);
    const resolved = resolveTarget(target, commands.data as CatalogItem[], clusters.data as CatalogItem[]);
    const { result } = await client.runJob({
      name: 'sqltools-heimdall-metadata',
      version: resolved.command.version ?? '0.0.1',
      context: sqlContext(sql),
      command_criteria: target.commandCriteria,
      cluster_criteria: target.clusterCriteria,
    });
    return result;
  }

  /**
   * Root of the tree: one `DATABASE` item per known namespace.
   *
   * Never crawls tables here (that's `MetadataCacheStore.refresh()`,
   * reserved for the explicit `refreshMetadata` command). The very first
   * expand of an empty cache still needs exactly one job to learn namespace
   * names at all; every expand after that is served from the in-memory
   * cache.
   */
  private async listDatabases(): Promise<NSDatabase.IDatabase[]> {
    const cache = this.metadataCache.readCache();
    let entry = cache.targets.kyuubi;
    if (!entry) {
      const names = columnValues(await this.runMetadataQuery(kyuubiShowNamespaces(HeimdallDriver.CATALOG)), ['namespace', 'name']);
      const namespaces: NamespaceTables = {};
      // ponytail: `[]` doubles as "not yet fetched" here (see `listTables`
      // below) — a namespace that is genuinely empty is indistinguishable
      // from one whose tables were never crawled, so it re-queries on every
      // expand instead of caching the empty result. Ceiling is one extra job
      // per truly-empty namespace per expand; upgrade path is a tri-state
      // (`undefined` | `[]` | `string[]`) if that ever matters in practice.
      names.forEach((name) => { namespaces[name] = []; });
      entry = { fetchedAt: Date.now(), namespaces };
      cache.targets.kyuubi = entry;
      this.metadataCache.writeCache(cache);
    }
    return Object.keys(entry.namespaces).map((name) => (<NSDatabase.IDatabase>{
      label: name,
      type: ContextValue.DATABASE,
      database: name,
      schema: name,
      iconId: 'database',
    }));
  }

  /**
   * Tables under one namespace. Cache hit -> no job. Cache miss (or the
   * empty-namespace ceiling noted above) -> exactly one `SHOW TABLES IN`,
   * then the result is written back so the next expand is a cache hit.
   */
  private async listTables(db: NSDatabase.IDatabase): Promise<NSDatabase.ITable[]> {
    const cache = this.metadataCache.readCache();
    const entry = cache.targets.kyuubi ?? { fetchedAt: Date.now(), namespaces: {} as NamespaceTables };
    let tables = entry.namespaces[db.label];
    if (!tables || tables.length === 0) {
      tables = columnValues(await this.runMetadataQuery(kyuubiShowTables(HeimdallDriver.CATALOG, db.label)), [
        'tableName',
        'table_name',
        'name',
      ]);
      entry.namespaces[db.label] = tables;
      cache.targets.kyuubi = entry;
      this.metadataCache.writeCache(cache);
    }
    return tables.map((name) => (<NSDatabase.ITable>{
      label: name,
      type: ContextValue.TABLE,
      database: db.label,
      schema: db.label,
      isView: false,
    }));
  }

  /**
   * Columns are never cached (FR-5): the cache format only stores namespace
   * -> table names, so every expand is a live `DESCRIBE`. Runs through the
   * existing `this.query()`/`IBaseQueries.fetchColumns` path rather than
   * `runMetadataQuery`, reusing the already-verified job pipeline for a live
   * (non-metadata-cache) tree read, same convention as driver.pg/driver.sqlite.
   *
   * Defensive per the trust boundary this file already keeps for
   * `columnValues`: Spark's `DESCRIBE` column names (`col_name`/`data_type`)
   * are read case-flexibly rather than assumed.
   */
  private async getColumns(table: NSDatabase.ITable): Promise<NSDatabase.IColumn[]> {
    const result = await this.singleQuery(this.queries.fetchColumns(table), {});
    if (result.error) {
      throw result.rawError;
    }
    return (result.results as unknown as Record<string, unknown>[])
      .map((row) => {
        const label = firstString(row, ['col_name', 'column_name', 'name']);
        const dataType = firstString(row, ['data_type', 'dataType', 'type']) ?? '';
        return { label, dataType };
      })
      .filter((c): c is { label: string; dataType: string } => !!c.label && c.label !== '')
      .map(({ label, dataType }) => (<NSDatabase.IColumn>{
        label,
        type: ContextValue.COLUMN,
        childType: ContextValue.NO_CHILD,
        dataType,
        isNullable: true,
        schema: table.schema,
        database: table.database,
        table,
      }));
  }

  public async getChildrenForItem({ item, parent }: Arg0<IConnectionDriver['getChildrenForItem']>): Promise<MConnectionExplorer.IChildItem[]> {
    switch (item.type) {
      case ContextValue.CONNECTION:
      case ContextValue.CONNECTED_CONNECTION:
        return this.listDatabases();
      case ContextValue.DATABASE:
        return <MConnectionExplorer.IChildItem[]>[
          { label: 'Tables', type: ContextValue.RESOURCE_GROUP, iconId: 'folder', childType: ContextValue.TABLE, schema: item.label, database: item.label },
        ];
      case ContextValue.TABLE:
        return <MConnectionExplorer.IChildItem[]>[
          { label: 'Columns', type: ContextValue.RESOURCE_GROUP, iconId: 'folder', childType: ContextValue.COLUMN, schema: item.schema, database: item.database },
        ];
      case ContextValue.RESOURCE_GROUP:
        if (item.childType === ContextValue.TABLE) {
          return this.listTables(parent as NSDatabase.IDatabase);
        }
        if (item.childType === ContextValue.COLUMN) {
          return this.getColumns(parent as NSDatabase.ITable);
        }
        return [];
    }
    return [];
  }

  /** IPC `REFRESH_METADATA` (`../ipc.ts`): full re-crawl irrespective of TTL. */
  public async refreshMetadata(): Promise<MetadataRequestResult> {
    const entry = await this.metadataCache.refresh('kyuubi', (sql) => this.runMetadataQuery(sql), {
      catalog: HeimdallDriver.CATALOG,
    });
    const namespaceCount = Object.keys(entry.namespaces).length;
    const tableCount = Object.values(entry.namespaces).reduce((total, tables) => total + tables.length, 0);
    const staleCount = entry.staleNamespaces?.length ?? 0;
    const message = staleCount > 0
      ? `Refreshed ${namespaceCount} namespaces / ${tableCount} tables (${staleCount} not refreshed)`
      : `Refreshed ${namespaceCount} namespaces / ${tableCount} tables`;
    return { message };
  }

  /** IPC `CLEAR_METADATA` (`../ipc.ts`): next expand re-fetches from scratch. */
  public clearMetadata(): MetadataRequestResult {
    this.metadataCache.writeCache({ version: CACHE_FORMAT_VERSION, targets: {} });
    return { message: 'Metadata cache cleared' };
  }
}

/** First present, non-empty string field among `candidates`, case-insensitively matched. */
function firstString(row: Record<string, unknown>, candidates: string[]): string | undefined {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const key = keys.find((k) => k.toLowerCase() === candidate.toLowerCase());
    if (key !== undefined) {
      const value = row[key];
      if (typeof value === 'string' && value !== '') {
        return value;
      }
    }
  }
  return undefined;
}
