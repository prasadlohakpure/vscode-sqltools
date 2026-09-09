// Spark/Kyuubi catalog queries for the object explorer tree (`getChildrenForItem`
// in `src/ls/driver.ts` — not wired here, see NOTES.md).
//
// This is NOT a port. The old extension's metadata came from Heimdall's own
// `/commands` and `/clusters` catalogs (unrelated data, no table listing at
// all) crawled into a client-side JSON cache. SQLTools instead expects real
// SQL against the target's catalog on every tree expansion (the
// `IBaseQueries` shape from driver.sqlite / driver.pg), so this is built
// fresh: Spark SQL's `SHOW DATABASES` / `SHOW TABLES IN` / `DESCRIBE` are
// what Kyuubi (Spark Thrift) supports for catalog introspection — see
// https://spark.apache.org/docs/latest/sql-ref-syntax-aux-show-databases.html
// and sql-ref-syntax-aux-show-tables.html.
//
// `metadataCache.ts`'s TTL crawl uses the two plain-string builders at the
// bottom (`kyuubiShowNamespaces`/`kyuubiShowTables`) directly against
// whatever `runQuery` it's given — that path doesn't go through
// `queryFactory`/`NSDatabase` typing because the cache is driver-agnostic
// (FR-7 in the source extension). The `IBaseQueries`-shaped builders above
// them are what a live (non-cached) `getChildrenForItem` would use, matching
// driver.sqlite/driver.pg's `queries.ts` convention.

import { IBaseQueries, NSDatabase } from '@sqltools/types';
import queryFactory from '@sqltools/base-driver/dist/lib/factory';

/** Spark: backtick each dotted segment, `` ` `` doubled. Same as metadata-cache.ts's `quoteSpark`. */
export function quoteSpark(identifier: string): string {
  return identifier
    .split('.')
    .map((part) => `\`${part.replace(/`/g, '``')}\``)
    .join('.');
}

// --- IBaseQueries shape (live tree / describe) ------------------------------

const fetchSchemas: IBaseQueries['fetchSchemas'] = queryFactory`
SHOW DATABASES
`;
// ponytail: Spark's SHOW DATABASES has no catalog-name column to alias as
// `schema`/`database` — its one column is already `databaseName`/`namespace`
// depending on version. driver.ts's caller maps the raw result into
// `NSDatabase.ISchema` itself (label = namespace, database = catalog param);
// a `queryFactory` template can't rename a column it doesn't control the
// name of without a per-Spark-version guess, so keep the query bare and let
// the driver massage the result — same reason `fetchSchemas` is untyped raw
// SQL here instead of a `SELECT ... AS label` projection like driver.pg's.

const fetchTables: IBaseQueries['fetchTables'] = queryFactory`
SHOW TABLES IN ${(p: NSDatabase.ISchema) => quoteSpark(p.schema)}
`;
// Same shape note as fetchSchemas: `SHOW TABLES IN <db>` returns
// (namespace, tableName, isTemporary) — no `label`/`type` aliasing available
// in plain SQL, so the driver's `getChildrenForItem` maps `tableName` ->
// `label` and stamps `ContextValue.TABLE` itself, the way it already reads
// `columnValues(..., ['tableName', 'table_name', 'name'])` for the cache.

const searchTables: IBaseQueries['searchTables'] = queryFactory`
SHOW TABLES ${(p: { search?: string }) => (p.search ? `LIKE '*${p.search}*'` : '')}
`;

/** `DESCRIBE` (not `DESCRIBE EXTENDED`): col_name/data_type/comment, no partition/detail noise. */
const describeTable: IBaseQueries['describeTable'] = queryFactory`
DESCRIBE ${(p: NSDatabase.ITable) => quoteSpark(`${p.schema}.${p.label}`)}
`;

const fetchColumns: IBaseQueries['fetchColumns'] = queryFactory`
DESCRIBE ${(p: NSDatabase.ITable) => quoteSpark(`${p.schema}.${p.label}`)}
`;
// ponytail: `DESCRIBE` mixes partition columns into the same rows with no
// marker, and reuses `col_name`/`data_type` names the driver must map to
// `label`/`dataType`/`${ContextValue.COLUMN}` after the fact (again, no
// column-rename available in the raw statement). If partition columns ever
// need to be excluded from the tree, switch to `DESCRIBE EXTENDED` and stop
// at the first blank `col_name` row (Spark's own convention for "partition
// info starts here").

export default {
  fetchSchemas,
  fetchTables,
  searchTables,
  describeTable,
  fetchColumns,
} as IBaseQueries;

// --- Plain-string builders for the TTL crawl (metadataCache.ts) ------------
//
// Verbatim from heimdall-vs-code-ext's metadata-cache.ts — these run through
// `RunMetadataQuery` (a raw SQL string in, a raw result out), not through
// `queryFactory`/`NSDatabase`, because the cache crawl doesn't have a
// `getChildrenForItem` parent item to build one from; it just walks the
// catalog top to bottom once per refresh.

export const kyuubiShowNamespaces = (catalog: string): string => `SHOW NAMESPACES IN ${quoteSpark(catalog)}`;
export const kyuubiShowTables = (catalog: string, namespace: string): string =>
  `SHOW TABLES IN ${quoteSpark(catalog)}.${quoteSpark(namespace)}`;
