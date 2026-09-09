/**
 * Packs Heimdall's own query result plus any safety/target-verification
 * warning strings into the shape SQLTools' native result grid renders.
 *
 * There is no custom webview in this architecture (unlike the old extension's
 * `results.ts`), so `NSDatabase.IResult.messages` — the field the grid already
 * shows above the results table — is the only surface available for
 * "read-only enforcement asked you to confirm", "this statement won't survive
 * past its own session" or "Heimdall ran on a different cluster than you
 * picked". See `NOTES.md` for what that does and does not cover.
 *
 * Structurally typed against `NSDatabase.IResult` (`packages/types/index.d.ts`)
 * rather than importing `vscode-sqltools` types here, matching the same
 * import-free convention `heimdall/safety.ts` and the old `results.ts`
 * already use.
 */

/** Structurally `ResultColumn` from `src/heimdall/client.ts`. */
export interface ResultColumnLike {
  name: string;
  type: string;
}

/** Structurally `QueryResult` from `src/heimdall/client.ts`. `{}` on the wire normalizes to both fields empty. */
export interface QueryResult {
  columns: ResultColumnLike[];
  data: unknown[][];
}

/** The subset of `NSDatabase.IResult` this function fills in. */
export interface AnnotatedResult {
  cols: string[];
  results: Record<string, unknown>[];
  messages: string[];
  error?: boolean;
  rawError?: Error;
}

/**
 * Shape a Heimdall `QueryResult` into SQLTools' grid format and attach
 * `warnings` (safety-rail and target-verification notices) as `messages`,
 * which SQLTools renders above the grid regardless of whether the query
 * succeeded.
 *
 * Row arrays are zipped against `columns` into the `{ [colName]: value }`
 * records the grid expects — `NSDatabase.IResult['results']` is untyped
 * (`any[]`) but every built-in driver hands it objects keyed by column name,
 * not positional arrays.
 */
export function annotateResult(result: QueryResult | undefined, warnings: readonly string[]): AnnotatedResult {
  const columns = result?.columns ?? [];
  const data = result?.data ?? [];
  const cols = columns.map((c) => c.name);
  const results = data.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      record[c.name] = row[i];
    });
    return record;
  });

  return {
    cols,
    results,
    messages: warnings.filter((w) => w.length > 0),
  };
}
