/**
 * Execution targets — Spark, reachable two ways: Kyuubi (interactive) and
 * spark-eks (batch) (UoW-04/18, FR-1).
 *
 * A two-row table, not a connector abstraction. Both backends speak one job API
 * with an identical `{"query": ...}` context shape, so per-backend classes would
 * all build the same JSON. Deliberate rung-1/2 decision, recorded in
 * requirements.md §4 ("No connector plugin framework").
 *
 * No `vscode` import on purpose: `node --test` loads this file straight from
 * source. The palette command, status-bar item and setting storage are wired by
 * the extension host; everything here is pure.
 */

// --- The table --------------------------------------------------------------

export type TargetId = 'kyuubi' | 'spark-eks';

/**
 * FR-1.6: a cold-start target must be labelled as one everywhere it's
 * selectable or displayed. Two values only — this is data the call sites read,
 * not a per-target hardcoded string.
 */
export type Latency = 'interactive' | 'batch-cold-start';

export interface Target {
  id: TargetId;
  label: string;
  /** Emitted as `command_criteria` on `POST /api/v1/job`. */
  commandCriteria: string[];
  /** Emitted as `cluster_criteria`. Must narrow to exactly one cluster. */
  clusterCriteria: string[];
  /** FR-1.6 labelling data — see `Latency`. */
  latency: Latency;
}

/**
 * Tag values read from `heimdall-config/configs/heimdall.yaml.tmpl`:
 * `kyuubi-adhoc-0.0.1` tags `[type:kyuubi]` (:170-179), cluster `kyuubi-adhoc`
 * tags `[type:kyuubi, data:prod]` (:609-624).
 *
 * `data:prod` on the Kyuubi row is load-bearing, not decoration. The reason is
 * a now-removed Snowflake target: its two clusters, `snowflake-heimdall-wh`
 * (`data:prod`) and `snowflake-heimdall-wh-dev` (`data:local`), were both
 * active and both tagged `type:snowflake` — so `["type:snowflake"]` alone
 * resolved to two clusters and Heimdall would have picked one at random. That
 * is the precedent `data:prod` guards against here: `type:kyuubi` currently has
 * one cluster, but it carries `data:prod` for the same reason, before a
 * `kyuubi-adhoc-dev` ever appears.
 *
 * ponytail: two hardcoded rows, no registry. Ceiling — a backend with a
 * genuinely different context shape. Upgrade path is another row here plus a
 * context builder, not an interface (requirements.md §4 "No connector plugin
 * framework").
 *
 * The `spark-eks` row (UoW-18) is the batch path confirmed in requirements.md
 * §2.1: command `spark-eks-sql-3.5.6` tags `[type:sparksql-eks]`
 * (`heimdall-config/configs/heimdall.yaml.tmpl:232-245`), cluster `spark-eks`
 * tags `[type:spark-eks, data:prod]` (:705-707).
 *
 * VERIFIED TRAP (a): `spark-sql-4.1.1` resolves to cluster `spark-4.1.1`, NOT
 * `spark-eks` — its `cluster_tags` is `type:spark-4.1.1` (heimdall.yaml.tmpl
 * :727-729), a separate cluster object. Both Heimdall cluster objects happen to
 * share the same underlying k8s `cluster_name: spark-eks` (:694, :717), which
 * is the EKS cluster they run on, not the Heimdall cluster name used in
 * criteria — that's what led an earlier draft to record the wrong pairing.
 *
 * VERIFIED TRAP (b): `data:prod` on the batch row's `clusterCriteria` is
 * prophylactic, same reasoning as the Kyuubi row above — `type:spark-eks`
 * matches exactly one cluster today, but the resolver breaks ties with
 * `rand.Int` (`job.go:443-458`), so a future `spark-eks-dev` tagged
 * `type:spark-eks` must not make this target silently non-deterministic.
 */
export const TARGETS: readonly Target[] = [
  {
    id: 'kyuubi',
    label: 'Kyuubi (SparkSQL)',
    commandCriteria: ['type:kyuubi'],
    clusterCriteria: ['type:kyuubi', 'data:prod'],
    latency: 'interactive',
  },
  {
    id: 'spark-eks',
    label: 'Spark (batch, EKS)',
    commandCriteria: ['type:sparksql-eks'],
    clusterCriteria: ['type:spark-eks', 'data:prod'],
    latency: 'batch-cold-start',
  },
];

/**
 * FR-1.6: the default must be an interactive path. `kyuubi` is the interactive
 * path this project builds against — Snowflake has been removed (see
 * requirements.md §2.0/scope revision 3).
 */
export const DEFAULT_TARGET_ID: TargetId = 'kyuubi';

export function targetById(id: string | undefined): Target | undefined {
  return TARGETS.find((t) => t.id === id);
}

// --- Catalog shape ----------------------------------------------------------

/**
 * The fields this module reads off a `/commands` or `/clusters` entry.
 * Structurally satisfied by `CatalogEntry` in `src/heimdall/client.ts`, so
 * neither file imports the other and this one stays dependency-free.
 *
 * `status` is `unknown` because it arrives as the string `"ACTIVE"` —
 * `status.Status.MarshalJSON` uppercases (`heimdall/pkg/object/status/status.go:60-68`)
 * while the YAML config spells it lowercase. Compared case-insensitively below.
 */
export interface CatalogItem {
  name: string;
  version?: string;
  status?: unknown;
  tags?: string[];
  cluster_tags?: string[];
}

function isActive(item: CatalogItem): boolean {
  // Absent status means the server omitted it (`json:"status,omitempty"`), which
  // for a listed object means it was serving requests. Only an explicit
  // non-active value disqualifies.
  return (
    item.status === undefined ||
    item.status === null ||
    (typeof item.status === 'string' && item.status.toLowerCase() === 'active')
  );
}

/** Heimdall's `Tags.Contains(criteria)`: the object's tags must contain ALL criteria. */
function containsAll(tags: string[] | undefined, criteria: string[] | undefined): boolean {
  if (!criteria || criteria.length === 0) {
    return true;
  }
  const owned = new Set(tags ?? []);
  return criteria.every((c) => owned.has(c));
}

// --- Resolution (FR-1.2, FR-1.3) --------------------------------------------

export interface ResolvedTarget {
  target: Target;
  command: CatalogItem;
  cluster: CatalogItem;
}

export type TargetResolutionKind = 'unavailable' | 'ambiguous';

/**
 * FR-1.3. `ambiguous` is not a warning we can swallow: Heimdall picks among
 * multiple matching pairs with `rand.Int`
 * (`heimdall/internal/pkg/heimdall/job.go:443-458`, with a TODO), so a target
 * that resolves twice means the user does not know which warehouse ran their
 * query. Never silently pick.
 */
export class TargetResolutionError extends Error {
  readonly targetId: string;
  readonly kind: TargetResolutionKind;
  /** `"command@cluster"` for each pair found. Empty for `unavailable`. */
  readonly pairs: string[];

  constructor(kind: TargetResolutionKind, target: Target, message: string, pairs: string[] = []) {
    super(message);
    this.name = 'TargetResolutionError';
    this.kind = kind;
    this.targetId = target.id;
    this.pairs = pairs;
  }
}

function fmt(criteria: string[]): string {
  return `[${criteria.join(', ')}]`;
}

/**
 * Mirrors `resolveJob` exactly: active command whose `tags` contain all
 * `commandCriteria`, then an active cluster whose `tags` contain both that
 * command's own `cluster_tags` AND the job's `clusterCriteria`.
 */
export function resolveTarget(
  target: Target,
  commands: readonly CatalogItem[],
  clusters: readonly CatalogItem[],
): ResolvedTarget {
  const activeCommands = commands.filter(isActive);
  const activeClusters = clusters.filter(isActive);
  const candidates = activeCommands.filter((c) => containsAll(c.tags, target.commandCriteria));

  if (candidates.length === 0) {
    throw new TargetResolutionError(
      'unavailable',
      target,
      `Target "${target.label}" unavailable: no active Heimdall command has tags ${fmt(target.commandCriteria)} ` +
        `(GET /api/v1/commands returned ${commands.length} command(s), ${activeCommands.length} active).`,
    );
  }

  const pairs: ResolvedTarget[] = [];
  for (const command of candidates) {
    for (const cluster of activeClusters) {
      if (
        containsAll(cluster.tags, command.cluster_tags) &&
        containsAll(cluster.tags, target.clusterCriteria)
      ) {
        pairs.push({ target, command, cluster });
      }
    }
  }

  if (pairs.length === 0) {
    const needed = new Set([...target.clusterCriteria]);
    for (const c of candidates) {
      for (const t of c.cluster_tags ?? []) {
        needed.add(t);
      }
    }
    throw new TargetResolutionError(
      'unavailable',
      target,
      `Target "${target.label}" unavailable: command(s) ${candidates.map((c) => c.name).join(', ')} matched, ` +
        `but no active cluster has tags ${fmt([...needed])} ` +
        `(cluster_criteria ${fmt(target.clusterCriteria)} plus the command's own cluster_tags; ` +
        `GET /api/v1/clusters returned ${clusters.length} cluster(s), ${activeClusters.length} active).`,
    );
  }

  if (pairs.length > 1) {
    const labels = pairs.map((p) => `${p.command.name}@${p.cluster.name}`);
    throw new TargetResolutionError(
      'ambiguous',
      target,
      `Target "${target.label}" is ambiguous: criteria ${fmt(target.commandCriteria)} / ${fmt(target.clusterCriteria)} ` +
        `resolve to ${pairs.length} command/cluster pairs (${labels.join(', ')}). Heimdall would pick one at random ` +
        `(job.go:443-458), so the query will not run until the criteria are narrowed. Refusing to guess.`,
      labels,
    );
  }

  return pairs[0];
}

export type TargetResolution =
  | ({ ok: true } & ResolvedTarget)
  | { ok: false; target: Target; error: TargetResolutionError };

/**
 * Validate every target against the live catalogs (FR-1.2). Catalogs are passed
 * in — fetch them with `client.listCommands()` / `client.listClusters()` and hand
 * over `page.data`, so this stays pure and testable.
 *
 * One broken target must not hide the working one, so failures are collected
 * rather than thrown.
 */
export function resolveTargets(
  commands: readonly CatalogItem[],
  clusters: readonly CatalogItem[],
  targets: readonly Target[] = TARGETS,
): TargetResolution[] {
  return targets.map((target) => {
    try {
      return { ok: true, ...resolveTarget(target, commands, clusters) } as TargetResolution;
    } catch (error) {
      if (error instanceof TargetResolutionError) {
        return { ok: false, target, error };
      }
      throw error;
    }
  });
}

// --- Post-submit verification (FR-1.3) --------------------------------------

export type VerificationState = 'match' | 'mismatch' | 'unverified';

export interface TargetVerification {
  state: VerificationState;
  /** Set for `mismatch` (loud) and `unverified` (informational). */
  message?: string;
  expected: { command: string; cluster: string };
  actual: { command?: string; cluster?: string };
}

/** Structurally a `Job` from `src/heimdall/client.ts`. */
export interface SubmitResponseFields {
  command_name?: string;
  cluster_name?: string;
}

function present(value: string | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Compare what Heimdall actually resolved against what the user picked.
 *
 * `runJob` returns the *submit-time* record, and both fields are `omitempty`, so
 * an async command can answer with neither. Absent is `unverified`, never
 * `mismatch` — reporting a fake mismatch on every async submit would train users
 * to ignore the real one.
 *
 * ponytail: no follow-up round trip. Ceiling — an async submit stays unverified
 * for the life of the job. Upgrade path: the poller in UoW-07 already calls
 * `getJob(id)` for the result path; re-run this against that record instead of
 * adding a second request to the interactive path.
 */
export function verifyResolvedTarget(
  target: ResolvedTarget,
  submitResponse: SubmitResponseFields | undefined | null,
): TargetVerification {
  const expected = { command: target.command.name, cluster: target.cluster.name };
  const actual = {
    command: present(submitResponse?.command_name),
    cluster: present(submitResponse?.cluster_name),
  };

  const diffs: string[] = [];
  if (actual.command !== undefined && actual.command !== expected.command) {
    diffs.push(`command "${expected.command}" but Heimdall ran "${actual.command}"`);
  }
  if (actual.cluster !== undefined && actual.cluster !== expected.cluster) {
    diffs.push(`cluster "${expected.cluster}" but Heimdall ran "${actual.cluster}"`);
  }

  if (diffs.length > 0) {
    return {
      state: 'mismatch',
      expected,
      actual,
      message:
        `Heimdall did not run this query on the target you picked. Expected ${diffs.join('; expected ')}. ` +
        `Criteria for "${target.target.label}" no longer resolve uniquely — treat the result as coming from ` +
        `an unknown backend and re-check GET /api/v1/clusters before trusting it.`,
    };
  }

  if (actual.command === undefined || actual.cluster === undefined) {
    return {
      state: 'unverified',
      expected,
      actual,
      message:
        `Target not verified: the submit response carried no ` +
        `${actual.command === undefined ? 'command_name' : ''}` +
        `${actual.command === undefined && actual.cluster === undefined ? '/' : ''}` +
        `${actual.cluster === undefined ? 'cluster_name' : ''}. ` +
        `Expected ${expected.command} on ${expected.cluster}; async commands report these only once the job record is fetched.`,
    };
  }

  return { state: 'match', expected, actual };
}

// --- Per-worksheet selection (FR-1.4) ---------------------------------------

/**
 * Workspace default plus per-document overrides. The extension host owns the
 * storage (a setting and `workspaceState`); this is the whole decision.
 */
export interface TargetSelection {
  /** `heimdall.defaultTarget` workspace setting. */
  default?: string;
  /** Keyed by `document.uri.toString()`. */
  overrides?: Record<string, string | undefined>;
}

/**
 * Per-document override beats the workspace default beats the built-in default.
 * An unrecognised id (a stale setting, a renamed target) falls through instead
 * of throwing — a bad setting must not make the extension unusable.
 */
export function effectiveTarget(
  selection: TargetSelection | undefined,
  documentUri: string | undefined,
): Target {
  const override = documentUri === undefined ? undefined : selection?.overrides?.[documentUri];
  return (
    targetById(override) ??
    targetById(selection?.default) ??
    targetById(DEFAULT_TARGET_ID) ??
    TARGETS[0]
  );
}

// --- Display copy (FR-1.6, FR-1.3) ------------------------------------------

/**
 * FR-1.6: only the cold-start target gets a badge, so an interactive one reads
 * as plain text. Not exported — `targetSummary` is its only caller, and every
 * display site goes through that so the badge cannot be forgotten at one of them.
 */
function latencyBadge(target: Target): string {
  return target.latency === 'batch-cold-start' ? ' (batch, cold start)' : '';
}

/**
 * `ok` — resolved to exactly one command + cluster at startup.
 * `error` — a real `TargetResolutionError` (ambiguous/unavailable). FR-1.3: never soften this.
 * `unverified` — still starting up, or validation could not run (offline/no credentials).
 *   Honest ignorance, which must never look like `error`'s actionable failure.
 */
export type TargetDisplayState = 'ok' | 'error' | 'unverified';

export interface TargetSummary {
  state: TargetDisplayState;
  /** Target label plus the FR-1.6 cold-start badge. */
  label: string;
  /** `command → cluster` when resolved, else the short reason it is not. */
  detail: string;
  /** The long form: the real resolution error, or the offline reason. */
  tooltip: string;
}

/**
 * The three-state target copy, in one place.
 *
 * Pure so it can be unit tested, and shared so the status bar and the sidebar
 * Target panel cannot drift into describing the same resolution differently —
 * which is exactly the confusion FR-1.3 is about. Callers own the presentation
 * (icon, colour, `TreeItem` vs `StatusBarItem`); this owns the words.
 */
export function targetSummary(
  target: Target,
  resolution: TargetResolution | undefined,
  offlineReason?: string,
): TargetSummary {
  const label = `${target.label}${latencyBadge(target)}`;
  if (resolution && resolution.ok) {
    const pair = `${resolution.command.name} → ${resolution.cluster.name}`;
    return { state: 'ok', label, detail: pair, tooltip: pair };
  }
  if (resolution && resolution.ok === false) {
    return { state: 'error', label, detail: 'unavailable', tooltip: resolution.error.message };
  }
  return {
    state: 'unverified',
    label,
    detail: 'not verified',
    tooltip:
      offlineReason ?? 'Heimdall targets not verified yet — click to pick from the static list.',
  };
}
