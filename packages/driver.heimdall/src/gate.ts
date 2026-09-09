/**
 * FR-1: pre-execute safety confirmation gate. Pure statement-splitting/checking
 * helpers used by `extension.ts`'s command wrappers before anything is handed
 * to the native `sqltools.executeQuery`/`executeCurrentQuery` commands.
 *
 * No `vscode` import here on purpose — keeps this testable the same way
 * `heimdall/safety.ts` is (see UoW-03).
 */
import { isReadOnly } from './heimdall/safety';

/**
 * ponytail: splits on top-level `;` only — no quote/comment awareness, so a
 * `;` inside a string literal is misread as a statement boundary. Same
 * trade-off `heimdall/safety.ts`'s regexes already document (regex over the
 * raw statement, not a parser). Upgrade path is a shared quote-aware scanner
 * — ported once a statement that actually trips this shows up in practice.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The statement enclosing `offset` in the full buffer `text`, delimited by
 * `;` — used for the no-selection ("current query") command, mirroring which
 * statement SQLTools itself is about to submit closely enough for a safety
 * check without re-implementing its query-boundary util (not a dependency of
 * this package — see `package.json`, pre-wired and out of scope for UoW-01).
 */
export function statementAt(text: string, offset: number): string {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ';') {
      if (i >= offset) {
        return text.slice(start, i);
      }
      start = i + 1;
    }
  }
  return text.slice(start);
}

/**
 * FR-1: true when `sql` holds no statements, or at least one statement in it
 * is not read-only per `isReadOnly` — i.e. the gate must ask before this runs.
 */
export function needsConfirmation(sql: string): boolean {
  return splitStatements(sql).some((s) => !isReadOnly(s));
}
