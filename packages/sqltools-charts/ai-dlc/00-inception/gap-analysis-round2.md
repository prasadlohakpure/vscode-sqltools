# Gap analysis, round 2 — DBCode / SQLTools feature re-check

Re-run of the DBCode/SQLTools comparison now that `driver.heimdall` and
`sqltools-charts` both exist. Research only — no source changes.

Method: grepped/read the actual code and docs listed in each row's
"evidence" rather than re-asserting round-1 conclusions from memory.
Round-1 decisions (`driver.heimdall/ai-dlc/00-inception/units-of-work.md`'s
"Deferred this pass" table, mirrored in `requirements.md`'s "Out of scope
this pass") are cited, not re-litigated, where they actually cover a row —
see the correction note under ER diagrams / SQL notebooks below where they
don't.

## DBCode's advertised features

| Feature | Status | Effort (gaps only) | Evidence |
|---|---|---|---|
| Charts | **Have it** | — | `sqltools-charts` chart panel: Column/Bar/Line/Area/Pie/Polar/Scatter/Combination via Chart.js, config UI picks type+columns, no re-query (`driver.heimdall/README.md` Features list; `packages/sqltools-charts/src/chart/`). |
| SQL notebooks | **Gap** | Large (multi-week) | Not in scope anywhere in round 1 — see correction below. Would need VS Code's Notebook API, a serializer, per-cell execution wired through the SQLTools connection layer. No existing seam to build on. |
| ER diagrams | **Gap** | Large, and low value here | Same correction as above — never scoped, not merely deferred. Also weakened by an existing limitation: `searchColumns`/metadata only covers one table at a time and Spark's `DESCRIBE` isn't FK-aware (`driver.heimdall/README.md` Known limitations), so a Heimdall-backed ER diagram would have no relationship data to draw beyond column lists. Not worth it until that metadata gap closes. |
| Data editing | **Deliberately out of scope** | — | Architectural, not an oversight: `driver.heimdall` enforces read-only at the safety-gate level (`src/gate.ts`/`heimdall/safety.ts`) and removed write-auth entirely rather than hiding it (`README.md` "No write support, for now": *"service-token / PATTERN__HEIMDALL_TOKEN auth and any escape hatch for non-read-only statements were both removed, not just hidden"*). Data editing needs writes; this driver structurally can't do them. |
| AI / MCP tools | **Gap** | Large | No prior scoping decision found in either package's `ai-dlc`. Would mean building an in-IDE chat/agent surface for SQL generation/explanation — a new subsystem, not an extension of anything that exists today. |
| Secure report sharing | **Gap** | Medium–large, and a poor fit | No prior scoping decision found. Would require a hosting/sharing backend for query results — orthogonal to (and in tension with) this being an internal, read-only, locally-installed pair of extensions (`README.md`: both packages `private: true`, no marketplace publishing — round-1 "Deferred this pass" table). Flagging as a gap for completeness, not recommending it. |
| Autocomplete | **Have it** | — | Core SQLTools feature, unrelated to our packages: `packages/plugins/intellisense/` + `CompletionItem`/`onCompletion` wiring in `packages/language-server/src/{connection,server}.ts`. |
| SQL formatter | **Have it** | — | Core SQLTools feature: `packages/formatter/` (`sqlFormatter.ts`, per-dialect formatters). Not something either `driver.heimdall` or `sqltools-charts` needed to build. |
| CSV / JSON export | **Have it** | — | Core SQLTools feature: `saveResults` command in `packages/plugins/connection-manager/extension.ts` (`ext_saveResults`), supports save-to-file or copy-to-clipboard as CSV or JSON, `Config.defaultExportType` / `ConfigRO.csvExport`. |
| Saved queries / bookmarks | **Have it**, plus **in progress this round** | — | Query-text bookmarks already exist core-side: `packages/plugins/bookmarks-manager` (driver-agnostic, extracts and stores query text). Complementary *file* bookmarking (bookmark a live `.sql` file path, not a frozen text snapshot) is UoW-07 of this round, being built in parallel in `packages/sqltools-charts/src/filebookmarks/` — not yet verifiable as done from here, so listed as in progress, not "have it" yet. |
| Query history with duration/status | **Have it** | — | Core: `packages/plugins/history-manager` (driver-agnostic query history). Plus `sqltools-charts`'s Query Output panel already logs duration/status/row count per executed query today (`driver.heimdall/README.md` Features: *"every executed query logged with duration/status/row count, click through to a full result table"*) — this is the pre-round-2 baseline, not new this round. |

### Correction on ER diagrams / SQL notebooks

The round-2 plan states these are "already recorded as deliberately
skipped in `driver.heimdall`'s own `units-of-work.md`". Checked both
`units-of-work.md`'s "Deferred this pass" table and `requirements.md`'s
"Out of scope this pass" table in full: neither ER diagrams nor SQL
notebooks appear anywhere in either round-1 doc, or in `user-stories.md`.
Only **marketplace publishing** is genuinely recorded there. Rather than
manufacture a citation that doesn't exist, this doc treats ER diagrams and
notebooks as fresh gaps, assessed above on their own merits.

## SQLTools core's own feature set (baseline, inherited by both packages)

| Feature | Status | Evidence |
|---|---|---|
| Multi-driver connection management | Have it | Core `connection-manager` plugin; `driver.heimdall` is one more driver on top of the existing framework. |
| Object explorer (DB/schema/table/column tree) | Have it | `driver.heimdall/src/explorer/`, cached with TTL (`README.md`). |
| Results grid (basic table) | Have it (DevExpress `dx-react-grid`) | `packages/plugins/connection-manager/webview/ui/screens/Results/components/Table`. Being superseded *inside `sqltools-charts`'s own panel only* by a Tabulator-based rich grid (sort, freeze/pin, group-by, column show/hide, etc.) — UoW-06, in progress this round; core's own grid is explicitly not being touched (round-2 decision note: extending DevExpress directly was rejected as an ongoing-merge-conflict fork of core UI). |
| Snippets | Have it | Core `packages/plugins/snippets-manager` (not modified by either package). |
| Query history (text) | Have it | `packages/plugins/history-manager`, see DBCode table above. |
| Query bookmarks (text) | Have it | `packages/plugins/bookmarks-manager`, see DBCode table above. |
| Read-only enforcement / row cap / cookie auth | Have it (Heimdall-specific, not core) | `driver.heimdall/README.md` Features — driver-level, not something core provides for any other driver. |
| Cancel-query UX | Deliberately deferred | `units-of-work.md` "Deferred this pass" and round-2's own "Explicitly out of scope this round" — not re-litigated here. |

## Genuinely new and cheap?

None found. Every real gap surfaced above (SQL notebooks, ER diagrams, AI/MCP
tools, secure report sharing) is a substantial new subsystem, not a small
addition — and the things that looked plausibly "just missing" (autocomplete,
formatter, CSV/JSON export, saved queries, query history with
duration/status) turned out to already exist in SQLTools core or to be
in flight this round. Not forcing a finding where there isn't one.
