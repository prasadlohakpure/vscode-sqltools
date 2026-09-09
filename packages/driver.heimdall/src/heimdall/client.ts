/**
 * Heimdall HTTP client — transport only.
 *
 * No `vscode` imports live in this file on purpose: it must stay runnable under
 * plain `node --test`. Ported from
 * `patterninc/agents/packages/shared/services/heimdallService.ts`; see
 * `ai-dlc/01-construction/bolts/bolt-03-heimdall-client.md` for the delta.
 *
 * Never log header values. The log hook below is handed method/path/status only.
 */

export const HEIMDALL_BASE_URL = 'https://heimdall.aws.pattern.com';
const API_PREFIX = '/api/v1';

/** `/jobs?limit=` is silently clamped server-side (job_dal.go defaultPageSize). */
export const MAX_PAGE_SIZE = 101;

// --- Status -----------------------------------------------------------------

/** Wire values of `pkg/object/job/status/status.go`. All eight, no invented ones. */
export const JOB_STATUSES = [
  'NEW',
  'ACCEPTED',
  'RUNNING',
  'FAILED',
  'KILLED',
  'SUCCEEDED',
  'CANCELING',
  'CANCELED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Terminal set, proven by the cancel guard `queries/job/status_cancel_update.sql`
 * (`not in (4,5,6,8)`). `CANCELING` is deliberately absent — a cancel is
 * cooperative and the worker only notices within ~10s, so a client that treats
 * `CANCELING` as terminal reports a job done while it is still running.
 */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'FAILED',
  'KILLED',
  'SUCCEEDED',
  'CANCELED',
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status as JobStatus);
}

// --- Errors -----------------------------------------------------------------

export class HeimdallError extends Error {
  readonly status?: number;
  readonly path?: string;

  constructor(message: string, status?: number, path?: string) {
    super(message);
    this.name = 'HeimdallError';
    this.status = status;
    this.path = path;
  }
}

/**
 * 3xx / 401 / 403. An expired Gatekeeper cookie answers with an Okta HTML
 * redirect rather than a clean 401 (NFR-12), so all three classify together and
 * redirects are never followed — otherwise a login page gets parsed as a result.
 */
export class HeimdallAuthError extends HeimdallError {
  constructor(message: string, status?: number, path?: string) {
    super(message, status, path);
    this.name = 'HeimdallAuthError';
  }
}

/** The job reached a non-SUCCEEDED terminal state. Not retryable — see FR-2.7. */
export class HeimdallJobFailedError extends HeimdallError {
  readonly jobId: string;
  readonly jobStatus: JobStatus;

  constructor(jobId: string, jobStatus: JobStatus, detail?: string) {
    super(`Job ${jobId} ${jobStatus}: ${detail || 'no error detail reported'}`);
    this.name = 'HeimdallJobFailedError';
    this.jobId = jobId;
    this.jobStatus = jobStatus;
  }
}

// --- Wire types -------------------------------------------------------------

export interface ResultColumn {
  name: string;
  type: string;
}

/**
 * Normalized result. Both fields are always present here even though the server
 * omits them: a zero-row result marshals to literally `{}` because `columns` and
 * `data` are both `omitempty` in Go.
 */
export interface QueryResult {
  columns: ResultColumn[];
  data: unknown[][];
}

export interface SubmitJobInput {
  name: string;
  version: string;
  description?: string;
  tags?: string[];
  /** Build this with `sqlContext()` for any SQL query — see its note on `return_result`. */
  context: Record<string, unknown>;
  command_criteria: string[];
  cluster_criteria: string[];
}

/**
 * The job context for a SQL query, for every target.
 *
 * `return_result: true` is **always** set, and it is set here rather than at each
 * call site because forgetting it fails silently in the worst way: `spark-eks`
 * attaches results to the job only when it is present
 * (`heimdall/internal/pkg/object/command/sparkeks/sparkeks.go:444-460`), so
 * omitting it yields a job that SUCCEEDS with nothing to display.
 *
 * Safe to send to Kyuubi, which has no such field
 * (`heimdall-config/internal/pkg/kyuubi/kyuubi.go:45-46`): Heimdall unmarshals a
 * job context into a `map[string]any` (`heimdall/pkg/context/context.go:26-46`)
 * and nothing in either repo sets `DisallowUnknownFields`, so the extra key is
 * ignored. One context shape works for all targets — which is what keeps this a
 * single function instead of a per-target builder.
 *
 * `extra` is spread FIRST so a caller cannot unset the invariant by passing it.
 */
export function sqlContext(
  query: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...extra, query, return_result: true };
}

/** Full job record. Note: `GET /job/{id}` does NOT include `result`. */
export interface Job {
  id: string;
  name: string;
  version: string;
  status: JobStatus;
  user?: string;
  description?: string;
  tags?: string[];
  context?: Record<string, unknown>;
  error?: string;
  is_sync?: boolean;
  created_at?: number;
  updated_at?: number;
  command_criteria?: string[];
  cluster_criteria?: string[];
  command_id?: string;
  command_name?: string;
  cluster_id?: string;
  cluster_name?: string;
  /** Only ever populated on the submit response, for sync commands. */
  result?: QueryResult;
  [key: string]: unknown;
}

/** `GET /job/{id}/status` — three fields. The cheapest poll (NFR-2). */
export interface JobStatusResponse {
  status: JobStatus;
  error?: string;
  updated_at?: number;
}

/** Keyset-paginated list envelope. Single-object GETs are NOT enveloped. */
export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor?: string;
}

export interface CatalogEntry {
  name: string;
  version?: string;
  tags?: string[];
  cluster_tags?: string[];
  [key: string]: unknown;
}

export interface ListJobsFilters {
  username?: string;
  id?: string;
  name?: string;
  version?: string;
  command?: string;
  cluster?: string;
  status?: JobStatus;
  tags?: string[];
  limit?: number;
  order_by?: string;
  direction?: 'asc' | 'desc';
  cursor?: string;
}

// --- Injected collaborators -------------------------------------------------

/**
 * Narrow contract for UoW-02's auth. Structurally satisfied by the `AuthHeaders`
 * that `src/auth.ts` `resolveAuth()` returns — no adapter, and no import, so
 * this module stays loadable by `node --test` straight from source.
 *
 * `headers` values are secrets. This client hands them to `fetch` and nowhere
 * else; `mode`/`source` are the deliberately non-secret fields and are the only
 * auth-related things that ever reach an error message or the log hook.
 */
export interface HeimdallAuth {
  headers: Record<string, string>;
  mode?: string;
  source?: string;
}

export interface HeimdallClientOptions {
  auth: HeimdallAuth;
  baseUrl?: string;
  /** Injected for tests; defaults to the Node 20+ global. */
  fetch?: typeof globalThis.fetch;
  /** Receives `"POST /api/v1/job -> 200"`. Never a header value. */
  log?: (message: string) => void;
  /** Transport-5xx retry. Retrying a *failed SQL statement* is never done. */
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface PollOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  maxIntervalMs?: number;
  timeoutMs?: number;
  onStatus?: (status: JobStatusResponse) => void;
}

// --- Parsing (trust boundary) -----------------------------------------------

const RETRYABLE_STATUS = new Set([502, 503, 504]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{}` -> zero columns, zero rows. Must not throw; this is the crash path. */
export function parseQueryResult(raw: unknown): QueryResult {
  if (!isRecord(raw)) {
    throw new HeimdallError('Result payload was not a JSON object');
  }
  const columns: ResultColumn[] = [];
  if (Array.isArray(raw.columns)) {
    for (const column of raw.columns) {
      if (!isRecord(column) || typeof column.name !== 'string') {
        throw new HeimdallError('Result column entry missing a string name');
      }
      columns.push({
        name: column.name,
        type: typeof column.type === 'string' ? column.type : 'unknown',
      });
    }
  }
  const data: unknown[][] = [];
  if (Array.isArray(raw.data)) {
    for (const row of raw.data) {
      if (!Array.isArray(row)) {
        throw new HeimdallError('Result row was not an array');
      }
      data.push(row);
    }
  }
  return { columns, data };
}

function parseStatus(raw: unknown, path: string): JobStatus {
  if (!isRecord(raw) || typeof raw.status !== 'string') {
    throw new HeimdallError(`Response from ${path} had no status field`);
  }
  if (!(JOB_STATUSES as readonly string[]).includes(raw.status)) {
    throw new HeimdallError(
      `Response from ${path} had unknown status "${raw.status}"`,
    );
  }
  return raw.status as JobStatus;
}

function parseJob(raw: unknown, path: string): Job {
  const status = parseStatus(raw, path);
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') {
    throw new HeimdallError(`Response from ${path} had no job id`);
  }
  const job = { ...record, status } as unknown as Job;
  job.result =
    record.result === undefined || record.result === null
      ? undefined
      : parseQueryResult(record.result);
  return job;
}

function parsePage<T>(raw: unknown, path: string): Page<T> {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new HeimdallError(`Response from ${path} was not a list envelope`);
  }
  return {
    data: raw.data as T[],
    has_more: raw.has_more === true,
    next_cursor:
      typeof raw.next_cursor === 'string' && raw.next_cursor !== ''
        ? raw.next_cursor
        : undefined,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// --- Client -----------------------------------------------------------------

export class HeimdallClient {
  private readonly auth: HeimdallAuth;
  private readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly log: (message: string) => void;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(options: HeimdallClientOptions) {
    this.auth = options.auth;
    this.baseUrl = (options.baseUrl ?? HEIMDALL_BASE_URL).replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.log = options.log ?? (() => {});
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 3_000;
  }

  // -- Endpoints --

  async submitJob(input: SubmitJobInput, signal?: AbortSignal): Promise<Job> {
    const raw = await this.request('/job', {
      method: 'POST',
      body: input,
      signal,
    });
    return parseJob(raw, '/job');
  }

  /** Cheapest poll — `status`, `error`, `updated_at` only. Use this, not getJob. */
  async getJobStatus(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<JobStatusResponse> {
    const path = `/job/${encodeURIComponent(jobId)}/status`;
    const raw = await this.request(path, { signal });
    const record = raw as Record<string, unknown>;
    return {
      status: parseStatus(raw, path),
      error: typeof record.error === 'string' ? record.error : undefined,
      updated_at:
        typeof record.updated_at === 'number' ? record.updated_at : undefined,
    };
  }

  /** Full record. Does not include `result` — that is a separate endpoint. */
  async getJob(jobId: string, signal?: AbortSignal): Promise<Job> {
    const path = `/job/${encodeURIComponent(jobId)}`;
    return parseJob(await this.request(path, { signal }), path);
  }

  /** 404s until the job is `SUCCEEDED`. */
  async getJobResult(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<QueryResult> {
    const path = `/job/${encodeURIComponent(jobId)}/result`;
    return parseQueryResult(await this.request(path, { signal }));
  }

  /** Only written after the job finishes — there is no mid-run log tailing. */
  async getJobStderr(jobId: string, signal?: AbortSignal): Promise<string> {
    return this.requestText(`/job/${encodeURIComponent(jobId)}/stderr`, signal);
  }

  async getJobStdout(jobId: string, signal?: AbortSignal): Promise<string> {
    return this.requestText(`/job/${encodeURIComponent(jobId)}/stdout`, signal);
  }

  /** Sets `CANCELING`. Cooperative: the worker notices within ~10s. */
  async cancelJob(jobId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/job/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      signal,
      allowEmptyBody: true,
    });
  }

  /** One page. `limit` is clamped client-side because the server clamps silently. */
  async listJobs(
    filters: ListJobsFilters = {},
    signal?: AbortSignal,
  ): Promise<Page<Job>> {
    const { tags, limit, ...rest } = filters;
    const query: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) {
        query[key] = String(value);
      }
    }
    if (tags?.length) {
      query.tags = tags;
    }
    if (limit !== undefined) {
      query.limit = String(Math.min(Math.max(1, limit), MAX_PAGE_SIZE));
    }
    const raw = await this.request('/jobs', { query, signal });
    return parsePage<Job>(raw, '/jobs');
  }

  /**
   * Walks every page via `next_cursor`. Raising `limit` past 101 does nothing,
   * so this is the only way to read more than one page.
   */
  async *iterateJobs(
    filters: ListJobsFilters = {},
    signal?: AbortSignal,
  ): AsyncGenerator<Job, void, void> {
    let cursor = filters.cursor;
    for (;;) {
      const page = await this.listJobs({ ...filters, cursor }, signal);
      // ponytail: `yield* page.data` is semantically identical but trips TS2766
      // under this workspace's TS 4.8 (fine on the reference repo's TS 5.6) —
      // a plain-loop rewrite, not a behavior change.
      for (const item of page.data) {
        yield item;
      }
      if (!page.has_more || !page.next_cursor) {
        return;
      }
      cursor = page.next_cursor;
    }
  }

  async listCommands(signal?: AbortSignal): Promise<Page<CatalogEntry>> {
    return parsePage<CatalogEntry>(
      await this.request('/commands', { signal }),
      '/commands',
    );
  }

  async listClusters(signal?: AbortSignal): Promise<Page<CatalogEntry>> {
    return parsePage<CatalogEntry>(
      await this.request('/clusters', { signal }),
      '/clusters',
    );
  }

  // -- Lifecycle (FR-2.5) --

  /** Polls `/status` with backoff until a terminal state, or throws on abort/timeout. */
  async waitForJob(
    jobId: string,
    options: PollOptions = {},
  ): Promise<JobStatusResponse> {
    const {
      signal,
      intervalMs = 300,
      maxIntervalMs = 3_000,
      timeoutMs = 300_000,
      onStatus,
    } = options;
    const deadline = Date.now() + timeoutMs;
    let delay = intervalMs;

    for (;;) {
      const status = await this.getJobStatus(jobId, signal);
      onStatus?.(status);
      if (isTerminalStatus(status.status)) {
        return status;
      }
      if (Date.now() >= deadline) {
        throw new HeimdallError(
          `Job ${jobId} still ${status.status} after ${timeoutMs}ms`,
        );
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), signal);
      delay = Math.min(Math.round(delay * 1.5), maxIntervalMs);
    }
  }

  /**
   * Submit, then either return the inline result (sync commands carry it on the
   * submit response) or poll `/status` and fetch `/result`.
   *
   * `onSubmit` fires with the submit record before any polling starts. It exists
   * because the job id is needed *while the job runs* — to cancel it, and to run
   * FR-1.3's `verifyResolvedTarget` against `command_name`/`cluster_name` — and
   * returning it only on completion would force every caller to re-implement
   * this method's inline-result short-circuit just to get at the id.
   */
  async runJob(
    input: SubmitJobInput,
    options: PollOptions & { onSubmit?: (job: Job) => void } = {},
  ): Promise<{ job: Job; status: JobStatus; result: QueryResult }> {
    const job = await this.submitJob(input, options.signal);
    options.onSubmit?.(job);

    if (job.result) {
      return { job, status: job.status, result: job.result };
    }

    let status = job.status;
    let error = job.error;

    if (!isTerminalStatus(status)) {
      const final = await this.waitForJob(job.id, options);
      status = final.status;
      error = final.error;
    }

    if (status !== 'SUCCEEDED') {
      throw new HeimdallJobFailedError(job.id, status, error);
    }

    return {
      job,
      status,
      result: await this.getJobResult(job.id, options.signal),
    };
  }

  // -- Transport --

  private async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      query?: Record<string, string | string[] | undefined>;
      allowEmptyBody?: boolean;
    } = {},
  ): Promise<unknown> {
    const response = await this.send(path, options);
    const text = await response.text();
    if (text.trim() === '') {
      if (options.allowEmptyBody) {
        return {};
      }
      throw new HeimdallError(`Empty response body from ${path}`, 200, path);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HeimdallError(`Response from ${path} was not JSON`, 200, path);
    }
  }

  private async requestText(
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.send(path, { signal })).text();
  }

  private async send(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      query?: Record<string, string | string[] | undefined>;
    },
  ): Promise<Response> {
    const method = options.method ?? 'GET';
    const url = new URL(this.baseUrl + API_PREFIX + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) {
        continue;
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, item);
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.auth.headers,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let lastError: HeimdallError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const response = await this.doFetch(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
        // NFR-12: never follow a redirect — an expired session answers with an
        // Okta login page, and following it means parsing HTML as a job result.
        redirect: 'manual',
      });

      this.log(`${method} ${API_PREFIX}${path} -> ${response.status}`);

      if (isAuthFailure(response.status)) {
        const credentials = this.auth.mode
          ? `${this.auth.mode} credentials${this.auth.source ? ` from ${this.auth.source}` : ''}`
          : 'the Heimdall credentials';
        throw new HeimdallAuthError(
          `Heimdall rejected ${method} ${API_PREFIX}${path} with HTTP ${response.status}: ${credentials} were rejected or have expired.` +
            (response.status < 400
              ? ' A 3xx here is an Okta login redirect, not a real result.'
              : ''),
          response.status,
          path,
        );
      }

      if (response.ok) {
        return response;
      }

      // Transport 5xx only. A failed SQL statement comes back as a FAILED job,
      // not as a 5xx, and is never retried.
      if (!RETRYABLE_STATUS.has(response.status)) {
        throw new HeimdallError(
          `Heimdall ${method} ${API_PREFIX}${path} failed: ${response.status} ${response.statusText}`,
          response.status,
          path,
        );
      }

      lastError = new HeimdallError(
        `Heimdall ${method} ${API_PREFIX}${path} failed: ${response.status} ${response.statusText}`,
        response.status,
        path,
      );

      if (attempt < this.maxAttempts) {
        await sleep(this.retryDelayMs, options.signal);
      }
    }

    throw (
      lastError ??
      new HeimdallError(`Heimdall ${method} ${API_PREFIX}${path} failed`, undefined, path)
    );
  }
}

/**
 * NFR-12: 3xx, 401 and 403 are one class of failure — an unusable session.
 * Mirrors `isAuthFailure` in `src/auth.ts`; duplicated (5 lines) rather than
 * imported so this transport module needs no `node:fs` dependency and stays
 * loadable from source under `node --test`.
 */
export function isAuthFailure(status: number): boolean {
  return (status >= 300 && status < 400) || status === 401 || status === 403;
}
