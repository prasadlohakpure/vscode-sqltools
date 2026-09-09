/**
 * FR-6 Safety rails.
 *
 * Neither connector guards against an unbounded or destructive statement:
 * Snowflake goes straight from the job context to `db.QueryContext`, Kyuubi
 * straight to `cursor.Execute` (`heimdall-config/internal/pkg/kyuubi/kyuubi.go:171`),
 * and Heimdall enforces no row cap either (requirements.md FR-6.2). This client
 * is the only place a read-only posture can exist, so it has to actually enforce
 * one rather than just render a warning after the fact.
 *
 * ponytail: regexes over the raw statement, not a parser — same trade-off
 * `statementRowCap` (results.ts) already makes and documents. Ceiling: a
 * string/comment containing the word `limit` or a keyword in a string literal
 * would be misread. Upgrade path is sharing `splitStatements`'s
 * quote/comment-aware scanner; the gate is someone actually hitting it.
 *
 * No imports, on purpose — same reason `config.ts` gives: `node --test` loads
 * this straight from source, and Node's `require()` type-stripping can't
 * resolve an extension-less relative import. `FALLBACK_LIMIT` below mirrors
 * `results.ts`'s `DEFAULT_MAX_ROWS` (1000) rather than importing it.
 */

/** Mirrors `results.ts`'s `DEFAULT_MAX_ROWS` — see the note above on why this isn't an import. */
const FALLBACK_LIMIT = 1000;

const READ_ONLY = /^\s*(select|show|describe|explain|with)\b/i;
const SESSION_STATEMENT = /^\s*(use|set|alter\s+session)\b/i;
const HAS_LIMIT = /\blimit\s+\d+\b/i;

/**
 * `splitStatements` (results.ts) keeps a statement's leading `-- ...` /
 * `/* ... *\/` comments rather than stripping them, so `-- note\nselect 1` is
 * a real, common input here — not stripping them first would misclassify
 * every commented statement as "not read-only" and never inject its `LIMIT`.
 * Classification-only: the comment stays in whatever SQL actually gets
 * submitted, this just skips past it to find the real keyword.
 */
function skipLeadingComments(sql: string): string {
  let i = 0;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i])) {
      i++;
    }
    if (sql.slice(i, i + 2) === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (sql.slice(i, i + 2) === '/*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    break;
  }
  return sql.slice(i);
}

/**
 * FR-6.2: SELECT/SHOW/DESCRIBE/EXPLAIN/WITH run without asking. Everything
 * else — INSERT/UPDATE/DELETE/CREATE/DROP, USE/SET/ALTER SESSION, anything
 * this scanner doesn't recognise — needs explicit per-execution confirmation.
 */
export function isReadOnly(sql: string): boolean {
  return READ_ONLY.test(skipLeadingComments(sql));
}

/**
 * FR-6.3: `USE` / `SET` / `ALTER SESSION` only affect the job that runs them —
 * every job gets a fresh session (FR-8) — so the context they set is gone
 * before the next statement in the same buffer sees it. Worth a distinct
 * warning from the generic write confirmation, because the risk here isn't
 * "this statement is destructive", it's "this statement is a no-op beyond
 * its own job".
 */
export function isSessionStatement(sql: string): boolean {
  return SESSION_STATEMENT.test(skipLeadingComments(sql));
}

/**
 * FR-6.1: append `LIMIT defaultLimit` to an interactive SELECT/WITH that has
 * none, anywhere in the statement — a `LIMIT` inside a subquery or CTE still
 * counts as "has one" (same conservative reading `statementRowCap` uses: a
 * false negative here just means an extra, harmless outer `LIMIT` is skipped).
 * Non-SELECT statements (SHOW/DESCRIBE/EXPLAIN/writes/session commands) are
 * returned unchanged — `LIMIT` on those is either meaningless or already the
 * server's problem, not this rail's.
 *
 * A trailing `;` or `-- comment` is preserved after the injected clause rather
 * than the clause being appended past it, which would be a syntax error or a
 * `LIMIT` swallowed into the comment.
 *
 * `defaultLimit` comes straight from `heimdall.results.maxRows` config, which
 * a misconfigured settings.json can make non-finite or fractional — normalized
 * here the same way `capResult` (results.ts) normalizes the same setting, so
 * this never emits `LIMIT NaN` or `LIMIT 3.14`.
 */
export function injectLimit(sql: string, defaultLimit: number): string {
  const limit = Math.max(1, Number.isFinite(defaultLimit) ? Math.floor(defaultLimit) : FALLBACK_LIMIT);
  if (!/^\s*(select|with)\b/i.test(skipLeadingComments(sql)) || HAS_LIMIT.test(sql)) {
    return sql;
  }

  let body = sql;
  let semi = '';
  const semiMatch = body.match(/;\s*$/);
  if (semiMatch?.index !== undefined) {
    semi = semiMatch[0];
    body = body.slice(0, semiMatch.index);
  }

  const trailingComment = body.match(/--[^\n]*$/);
  if (trailingComment?.index !== undefined) {
    const head = body.slice(0, trailingComment.index).replace(/\s+$/, '');
    return `${head} LIMIT ${limit} ${trailingComment[0]}${semi}`;
  }
  return `${body.replace(/\s+$/, '')} LIMIT ${limit}${semi}`;
}
