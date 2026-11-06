import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { canonicalJson } from "../../core/payload";
import { RHQ_TEST_TOKEN_PREFIX } from "../crypto/token";
import {
  BodyTooLargeError,
  type ByteStream,
  declaredLength,
  MAX_BODY_BYTES,
  readTextCapped,
} from "../net/boundedBody";
import {
  safeFetch,
  UnexpectedRedirectError,
  UnsafeDestinationError,
} from "../net/safeFetch";
import { USER_AGENT } from "./clientInfo";

// The Royalties HQ API client.
//
// One request per call, no retry loop: a retry can be an hour away, so the
// caller persists attempt state and asks ./retry.ts when to come back.
// Every answer becomes a value (success, or an RhqProblem) rather than an
// exception, because every one of them is an expected outcome the push step
// has to record and show; only a programming error (a body for the wrong
// month) throws.

// ---------------------------------------------------------------------------
// API types, in RHQ's snake_case; the client's own additions are camelCase.

export type SnapshotStatus = "staged" | "rejected" | "imported";
export type TokenMode = "live" | "test";

export interface ConnectionPeriod {
  period: string;
  status: SnapshotStatus;
  /** The cut-off the month was last pushed with. Reuse it on a re-push. */
  refund_cutoff_at: string | null;
  import_id: number | null;
}

/** The handshake's `data`. */
export interface RhqConnection {
  id: number;
  name: string;
  platform: string;
  marketplace: string;
  currency: string;
  royalty_period_months: number;
  royalty_period_start: number;
  backfill_start_month: string | null;
  token: { mode: TokenMode; expires_at: string | null };
  periods: ConnectionPeriod[];
  /**
   * The next three describe the install. Each is
   * null when the install predates them: the service talks to many
   * installs, each upgraded on its own, so a missing one means "assume the
   * oldest behaviour", never a broken answer.
   */
  auto_import: boolean | null;
  store: { bound: boolean } | null;
  api: RhqApi | null;
}

/** The limits this client sizes requests by; others are ignored. */
export const API_LIMIT_KEYS = [
  "max_rows",
  "max_body_bytes",
  "max_inflated_body_bytes",
  "max_json_values",
  "max_json_containers",
  "rows_per_day",
  "writes_per_minute",
  "writes_per_day",
  "reads_per_minute",
] as const;
export type ApiLimitKey = (typeof API_LIMIT_KEYS)[number];

export interface RhqApi {
  /** Optional request behaviours the install accepts (`store_id`, `gzip`). */
  features: string[];
  limits: Partial<Record<ApiLimitKey, number>>;
}

/** A snapshot as RHQ reports it. */
export interface RhqSnapshot {
  period: string;
  result?: "created" | "replaced" | "unchanged";
  status: SnapshotStatus;
  rejection_code: string | null;
  import_id: number | null;
  refund_cutoff_at: string | null;
  received_at: string;
  /**
   * SHA-256 of the body RHQ holds for the month (of the inflated JSON for
   * a gzip push): a receipt the push step compares with what it sent. Null
   * on a dry run that would have changed the month, and when the month's
   * import was deleted; undefined (absent) only from an install that
   * predates it. The two must stay apart: null is RHQ saying it holds no
   * receipt, not that it cannot give one.
   */
  payload_sha256?: string | null;
  counts: { rows: number; errors: number; warnings: number };
  errors: Record<string, string[]>;
  /**
   * The client's reading of `errors`, one entry per message, with the
   * stable `reason` code RHQ attaches to some. `errors` above keeps only the
   * messages.
   */
  errorEntries: RhqErrorEntry[];
  /** RHQ left keys or messages out of `errors`; counts.errors is whole. */
  errors_truncated: boolean;
  /**
   * Why a staged month waits for a person rather than being imported
   * (`anomaly`, `no_baseline`, `before_backfill_start`, `duplicate_period`).
   * Not an error: the push was accepted.
   */
  hold_back_reasons: string[];
  /** `import`: the month's import page in RHQ, for a person; same origin as the API. */
  links: { self: string; import: string | null };
}

export interface RhqErrorEntry {
  /** The `errors` key (`rows`, `rows.3`); `rows` for a keyless entry. */
  key: string;
  message: string;
  reason: string | null;
}

/**
 * A failure. RHQ's problem+json fields, plus local codes for failures with
 * no usable HTTP answer: network_error, timeout, unsafe_destination,
 * unexpected_redirect, unexpected_response, response_too_large. Branch only on `code`; title
 * and detail are for people and RHQ may reword them.
 */
export interface RhqProblem {
  code: string;
  title: string;
  detail: string | null;
  /** The HTTP status, or null when no answer was received. */
  status: number | null;
  errors?: Record<string, string[]>;
  retryAfterSeconds?: number | null;
  /** On 409s: the month's import in RHQ. */
  importId?: number | null;
  /** On duplicate_period: the imports that already hold the month. */
  importIds?: number[];
  /** A problem answered to a test-mode token. */
  mode?: TokenMode;
  /** A problem answered by POST …/validate. */
  dryRun?: boolean;
  /** RHQ cut `errors` down to fit; errorsTotal is the full count. */
  errorsTruncated?: boolean;
  errorsTotal?: number;
}

export type Failure = { ok: false; problem: RhqProblem };

export type HandshakeOutcome =
  | { ok: true; status: 200; connection: RhqConnection; mode: TokenMode }
  | Failure;

export type SnapshotWriteOutcome =
  | {
      ok: true;
      // RHQ answers 202 for created; 201 is accepted
      // anyway so a future RHQ that uses it is not mistaken for a failure.
      status: 200 | 201 | 202;
      result: "created" | "replaced" | "unchanged";
      snapshot: RhqSnapshot;
      mode: TokenMode;
      dryRun: boolean;
    }
  | Failure;

export type SnapshotReadOutcome =
  { ok: true; status: 200; snapshot: RhqSnapshot } | Failure;

/**
 * True only for a live push that RHQ accepted (created, replaced or
 * unchanged). The one test the push step may use to mark a period pushed:
 * a test-mode answer or a dry run looks like success but created nothing,
 * and marking the month pushed would stop it ever being pushed for real.
 */
export function isLiveAcceptance(outcome: SnapshotWriteOutcome): boolean {
  return outcome.ok && outcome.mode === "live" && !outcome.dryRun;
}

/**
 * The refund cut-off RHQ recorded for a period. A re-push must
 * send this, not a cut-off computed today, or refunds would move between
 * months. Null when the period was never pushed (or RHQ has no cut-off).
 */
export function recordedCutoff(
  connection: RhqConnection,
  period: string,
): string | null {
  return (
    connection.periods.find((p) => p.period === period)?.refund_cutoff_at ??
    null
  );
}

// ---------------------------------------------------------------------------
// Transport.

/** The slice of fetch the client needs; safeFetch and global fetch fit it. */
export type RhqFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  /**
   * Read in capped chunks when present (safeFetch's Response always has
   * it). A fake without a stream falls back to text(), still capped.
   */
  body?: ByteStream | null;
  text(): Promise<string>;
}>;

/**
 * One line per request. Deliberately no token (or anything derived from it
 * that could be replayed) and no payload: the payload is the publisher's
 * sales data, and the hash is enough to match a log line to a stored push.
 */
export interface RhqLogEntry {
  method: string;
  path: string;
  status: number | null;
  code: string | null;
  durationMs: number;
  payloadHash: string | null;
}

export type RhqLogger = (entry: RhqLogEntry) => void;

const defaultLogger: RhqLogger = (entry) => {
  console.info(JSON.stringify({ event: "rhq_request", ...entry }));
};

/** Spec: the largest push takes ~13 s inside the request; 60 s is the limit. */
export const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Handshake cache.

/** Short: long enough to spare RHQ one GET per page view or job step, short
 * enough that a token revoked in RHQ is noticed within minutes. */
export const HANDSHAKE_TTL_MS = 10 * 60_000;

export interface HandshakeCache {
  get(key: string, now: number): RhqConnection | undefined;
  set(key: string, value: RhqConnection, now: number): void;
  delete(key: string): void;
  keys(): string[];
}

export function createHandshakeCache(ttlMs = HANDSHAKE_TTL_MS): HandshakeCache {
  const entries = new Map<string, { value: RhqConnection; until: number }>();
  return {
    get(key, now) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now >= hit.until) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value, now) {
      entries.set(key, { value, until: now + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
    keys: () => [...entries.keys()],
  };
}

// Process-wide, so every client for the same (URL, token) shares it: the
// push step and the settings page build their own clients.
const processHandshakeCache = createHandshakeCache();

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// The client.

export interface RhqClientOptions {
  /** The API base URL, ending in /api/v1 (a trailing slash is ignored). */
  baseUrl: string;
  token: string;
  /**
   * This store's `store.id` (`medusa:` plus the Medusa store id).
   * Used only by bodyFor, and only for an install that lists `store_id`.
   */
  storeId?: string;
  fetch?: RhqFetch;
  now?: () => Date;
  logger?: RhqLogger;
  timeoutMs?: number;
  handshakeCache?: HandshakeCache;
}

const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/** bodyFor was asked for a store_id install's body with no store id set. */
export class StoreIdRequiredError extends Error {
  name = "StoreIdRequiredError";
  constructor() {
    super(
      "This Royalties HQ install binds stores (store_id), but no store id was given to the client.",
    );
  }
}

export interface WriteOptions {
  /**
   * Send the body gzipped. Only for an install whose handshake lists `gzip`
   * in `api.features`: an older one answers 415.
   */
  gzip?: boolean;
}

export function createRhqClient(options: RhqClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const baseOrigin = new URL(baseUrl).origin;
  const token = options.token;
  const fetchImpl: RhqFetch = options.fetch ?? (safeFetch as RhqFetch);
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? defaultLogger;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = options.handshakeCache ?? processHandshakeCache;
  // Keyed by a hash so the cache never holds a second copy of the secret.
  const cacheKey = `${baseUrl} ${sha256(token)}`;

  // The token's prefix says test mode before any answer does; answers can
  // only confirm it. Starting from the prefix means that even an answer
  // missing its "mode" marker can never be taken for a live push.
  let knownMode: TokenMode | null = token.startsWith(RHQ_TEST_TOKEN_PREFIX)
    ? "test"
    : null;
  const noteMode = (mode: TokenMode | undefined): TokenMode => {
    if (mode === "test" || knownMode === "test") knownMode = "test";
    else knownMode = mode ?? knownMode ?? "live";
    return knownMode;
  };

  async function request(
    method: "GET" | "PUT" | "POST",
    path: string,
    body?: string | Uint8Array,
    writeOptions: WriteOptions = {},
  ): Promise<
    | { kind: "answer"; status: number; headers: HeaderLike; text: string }
    | { kind: "failure"; problem: RhqProblem }
  > {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      // Names the plugin and its version, nothing about the store: RHQ's
      // logs can tell clients apart without learning who is pushing.
      "User-Agent": USER_AGENT,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // RHQ hashes the inflated JSON, so compressing changes nothing it
    // compares; the log's hash stays the hash of the JSON for the same reason.
    const wire =
      body !== undefined && writeOptions.gzip ? gzipSync(body) : body;
    if (wire !== body) headers["Content-Encoding"] = "gzip";
    const started = now().getTime();
    // Set once the headers arrive: a body that then breaks off still had
    // this status, and a 2xx may have stored the month.
    let received: number | null = null;
    const entry = (status: number | null, code: string | null) => {
      log({
        method,
        path: new URL(url).pathname,
        status,
        code,
        durationMs: now().getTime() - started,
        payloadHash: body === undefined ? null : sha256(body),
      });
    };
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: wire,
        // Covers reading the body too: the signal aborts the stream.
        signal: AbortSignal.timeout(timeoutMs),
      });
      received = response.status;
      // Capped: a wrong or hostile base URL could
      // otherwise stream the worker out of memory through text(). RHQ's
      // largest answer (a snapshot with its errors) is a few KB.
      const declared = declaredLength(response.headers);
      if (declared !== null && declared > MAX_BODY_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new ResponseTooLargeError(response.status);
      }
      let text: string;
      try {
        text =
          response.body !== undefined
            ? await readTextCapped(response.body, MAX_BODY_BYTES)
            : await response.text();
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          throw new ResponseTooLargeError(response.status);
        }
        throw error;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
        throw new ResponseTooLargeError(response.status);
      }
      const answer = {
        kind: "answer" as const,
        status: response.status,
        headers: response.headers,
        text,
      };
      entry(response.status, codeOf(answer));
      return answer;
    } catch (error) {
      const problem = localProblem(error, timeoutMs);
      if (problem.status === null) problem.status = received;
      entry(problem.status, problem.code);
      return { kind: "failure", problem };
    }
  }

  function retryAfterOf(headers: HeaderLike): number | null {
    const raw = headers.get("retry-after");
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    // RFC 9110 also allows an HTTP-date; RHQ sends seconds, but a proxy in
    // front of it (maintenance page) may not.
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    return Math.max(0, Math.ceil((at - now().getTime()) / 1000));
  }

  function failureFrom(answer: Answer): Failure {
    const retryAfterSeconds = retryAfterOf(answer.headers);
    const problem = parseProblem(answer);
    if (problem)
      return { ok: false, problem: { ...problem, retryAfterSeconds } };
    return {
      ok: false,
      problem: {
        code: "unexpected_response",
        title: "Unexpected answer from Royalties HQ",
        // The body is not quoted: it may be anything a proxy or a wrong URL
        // serves, and this detail is shown in the admin and emailed.
        detail: `Royalties HQ answered HTTP ${answer.status} with a body this plugin does not understand. Check the API base URL.`,
        status: answer.status,
        retryAfterSeconds,
      },
    };
  }

  async function handshake(
    opts: { fresh?: boolean } = {},
  ): Promise<HandshakeOutcome> {
    if (!opts.fresh) {
      const hit = cache.get(cacheKey, now().getTime());
      if (hit) {
        return {
          ok: true,
          status: 200,
          connection: hit,
          mode: noteMode(hit.token.mode),
        };
      }
    }
    const answer = await request("GET", "/connection");
    if (answer.kind === "failure")
      return { ok: false, problem: answer.problem };
    if (answer.status !== 200) return failureFrom(answer);
    const connection = readConnection(parseJson(answer.text));
    if (!connection) return failureFrom(answer);
    // Only successes are cached: a failure must be re-checked next time,
    // or a just-fixed token would keep failing for the TTL.
    cache.set(cacheKey, connection, now().getTime());
    return {
      ok: true,
      status: 200,
      connection,
      mode: noteMode(connection.token.mode),
    };
  }

  function assertBodyForPeriod(period: string, payload: string | Uint8Array) {
    if (!PERIOD.test(period)) {
      throw new Error(`Not a snapshot period (YYYY-MM): ${period}`);
    }
    const text =
      typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("The snapshot payload is not valid JSON.");
    }
    const bodyPeriod = (parsed as { period?: unknown } | null)?.period;
    // RHQ would answer 422 validation_failed, but that would be recorded as
    // a rejection of the month; a body for another month is our bug, not
    // the store's data, so it must never leave the process.
    if (bodyPeriod !== period) {
      throw new Error(
        `The payload's period (${String(bodyPeriod)}) does not match the URL's period (${period}).`,
      );
    }
  }

  async function write(
    method: "PUT" | "POST",
    path: string,
    period: string,
    payload: string | Uint8Array,
    writeOptions: WriteOptions = {},
  ): Promise<SnapshotWriteOutcome> {
    assertBodyForPeriod(period, payload);
    // Sent as given: RHQ's "unchanged" answer is keyed on the SHA-256 of the
    // raw body, so any re-serialisation here could turn a no-op into a
    // replace (see src/lib/hash/payloadHash.ts). bodyFor makes those bytes.
    const answer = await request(method, path, payload, writeOptions);
    if (answer.kind === "failure")
      return { ok: false, problem: answer.problem };
    // Any answer RHQ actually gave may have changed the connection's
    // periods (a new cut-off, staged → rejected), and a 401/403 means the
    // cached handshake is stale; either way the next handshake must ask.
    cache.delete(cacheKey);
    if (answer.status !== 200 && answer.status !== 201 && answer.status !== 202)
      return withModeFlags(failureFrom(answer));
    const envelope = readSnapshotEnvelope(parseJson(answer.text), baseOrigin);
    const result = envelope?.data.result;
    if (!envelope || !result) return failureFrom(answer);
    return {
      ok: true,
      status: answer.status,
      result,
      snapshot: envelope.data,
      mode: noteMode(envelope.mode === "test" ? "test" : undefined),
      dryRun: envelope.dry_run === true,
    };
  }

  function withModeFlags(failure: Failure): Failure {
    if (failure.problem.mode === "test") noteMode("test");
    return failure;
  }

  return {
    timeoutMs,
    /** GET /connection. Cached for HANDSHAKE_TTL_MS unless `fresh`. */
    handshake,
    invalidateHandshake(): void {
      cache.delete(cacheKey);
    },
    /**
     * The token's mode as far as it is known: from its prefix, the
     * handshake, or a write's `mode` marker. "test" is sticky.
     */
    mode(): TokenMode | null {
      return knownMode;
    },
    /**
     * The exact bytes to send for a built payload: its canonical JSON, with
     * `store.id` attached when the install lists `store_id`. Attached
     * here, at send time, never in the built payload, so a store that moves
     * keeps the same history. The push step hashes and stores these bytes
     * before it sends them, and compares RHQ's payload_sha256 with them.
     * Throws StoreIdRequiredError for a store_id install without a store id:
     * an unbound push would leave the connection open to any store.
     */
    bodyFor(payload: object, connection: RhqConnection): string {
      const bindsStores = connection.api?.features.includes("store_id") === true;
      if (!bindsStores) return canonicalJson(payload);
      if (options.storeId === undefined || options.storeId === "") {
        throw new StoreIdRequiredError();
      }
      return canonicalJson({ ...payload, store: { id: options.storeId } });
    },
    /** PUT /sales-snapshots/{period} with the exact canonical bytes. */
    putSnapshot(
      period: string,
      payload: string | Uint8Array,
      writeOptions?: WriteOptions,
    ) {
      return write(
        "PUT",
        `/sales-snapshots/${period}`,
        period,
        payload,
        writeOptions,
      );
    },
    /** POST /sales-snapshots/{period}/validate: a dry run, nothing kept. */
    validateSnapshot(
      period: string,
      payload: string | Uint8Array,
      writeOptions?: WriteOptions,
    ) {
      return write(
        "POST",
        `/sales-snapshots/${period}/validate`,
        period,
        payload,
        writeOptions,
      );
    },
    /** GET /sales-snapshots/{period}. */
    async getSnapshot(period: string): Promise<SnapshotReadOutcome> {
      if (!PERIOD.test(period)) {
        throw new Error(`Not a snapshot period (YYYY-MM): ${period}`);
      }
      const answer = await request("GET", `/sales-snapshots/${period}`);
      if (answer.kind === "failure")
        return { ok: false, problem: answer.problem };
      if (answer.status !== 200) return failureFrom(answer);
      const envelope = readSnapshotEnvelope(parseJson(answer.text), baseOrigin);
      if (!envelope) return failureFrom(answer);
      return { ok: true, status: 200, snapshot: envelope.data };
    },
  };
}

export type RhqClient = ReturnType<typeof createRhqClient>;

// ---------------------------------------------------------------------------
// Parsing. Hand-written guards rather than a schema library: the plugin has no
// runtime validator dependency, and these check exactly what the code then
// reads.

interface HeaderLike {
  get(name: string): string | null;
}

interface Answer {
  status: number;
  headers: HeaderLike;
  text: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isString = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNullableString = (v: unknown) => v === null || isString(v);
const isNullableInt = (v: unknown) => v === null || isInt(v);
const STATUSES = new Set(["staged", "rejected", "imported"]);
const CODE = /^[a-z0-9_]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Additive fields are read leniently: an install without them, or with a
// value this client does not know, still gives a usable answer (store
// connectors), with the field reading as "nothing said".
function readApi(value: unknown): RhqApi | null {
  if (!isRecord(value)) return null;
  const features = Array.isArray(value.features)
    ? value.features.filter((f): f is string => isString(f) && CODE.test(f))
    : [];
  const limits: Partial<Record<ApiLimitKey, number>> = {};
  if (isRecord(value.limits)) {
    for (const key of API_LIMIT_KEYS) {
      const n = value.limits[key];
      if (isInt(n) && n > 0) limits[key] = n;
    }
  }
  return { features, limits };
}

function isErrorMessages(v: unknown): v is Record<string, string[]> {
  return (
    isRecord(v) &&
    Object.values(v).every((m) => Array.isArray(m) && m.every(isString))
  );
}

function readConnection(body: unknown): RhqConnection | null {
  if (!isRecord(body) || !isRecord(body.data)) return null;
  const d = body.data;
  const token = d.token;
  if (
    !isInt(d.id) ||
    !isString(d.name) ||
    !isString(d.platform) ||
    !isString(d.marketplace) ||
    !isString(d.currency) ||
    !isInt(d.royalty_period_months) ||
    !isInt(d.royalty_period_start) ||
    !isNullableString(d.backfill_start_month) ||
    !isRecord(token) ||
    (token.mode !== "live" && token.mode !== "test") ||
    !isNullableString(token.expires_at) ||
    !Array.isArray(d.periods)
  ) {
    return null;
  }
  const periods: ConnectionPeriod[] = [];
  for (const p of d.periods) {
    if (
      !isRecord(p) ||
      !isString(p.period) ||
      !isString(p.status) ||
      !STATUSES.has(p.status) ||
      !isNullableString(p.refund_cutoff_at) ||
      !isNullableInt(p.import_id)
    ) {
      return null;
    }
    periods.push({
      period: p.period,
      status: p.status as SnapshotStatus,
      refund_cutoff_at: p.refund_cutoff_at as string | null,
      import_id: p.import_id as number | null,
    });
  }
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    marketplace: d.marketplace,
    currency: d.currency,
    royalty_period_months: d.royalty_period_months,
    royalty_period_start: d.royalty_period_start,
    backfill_start_month: d.backfill_start_month as string | null,
    token: {
      mode: token.mode,
      expires_at: token.expires_at as string | null,
    },
    periods,
    auto_import: typeof d.auto_import === "boolean" ? d.auto_import : null,
    store:
      isRecord(d.store) && typeof d.store.bound === "boolean"
        ? { bound: d.store.bound }
        : null,
    api: readApi(d.api),
  };
}

/**
 * A snapshot's `errors`, in either shape RHQ may send: messages
 * (arrays of message strings by key), or reason-coded entries
 * (`{row, reason, message}` objects, in those arrays or as a bare array).
 * Accepting both is deliberate: a GET that fails to parse becomes unexpected_response, which
 * would hide exactly the failed import the entry reports. Anything else is
 * refused.
 */
function readSnapshotErrors(value: unknown): RhqErrorEntry[] | null {
  const entryOf = (key: string, item: unknown): RhqErrorEntry | null => {
    // RHQ keys a failed commit `import`, never `rows`: it is not about the
    // pushed data, and the key is what a client branches on.
    if (isString(item))
      return {
        key,
        message: item,
        reason: key === "import" ? "import_failed" : null,
      };
    if (!isRecord(item)) return null;
    const message = isString(item.message) ? item.message : null;
    const reason = isString(item.reason) ? item.reason : null;
    if (message === null && reason === null) return null;
    return { key, message: message ?? "", reason };
  };
  const entries: RhqErrorEntry[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      // A keyless entry is about the snapshot as a whole unless it names
      // its (zero-based) row, which `errors` would key `rows.{n}`.
      const row = isRecord(item) && isInt(item.row) ? item.row : null;
      const entry = entryOf(row === null ? "rows" : `rows.${row}`, item);
      if (!entry) return null;
      entries.push(entry);
    }
    return entries;
  }
  if (!isRecord(value)) return null;
  for (const [key, messages] of Object.entries(value)) {
    if (!Array.isArray(messages)) return null;
    for (const item of messages) {
      const entry = entryOf(key, item);
      if (!entry) return null;
      entries.push(entry);
    }
  }
  return entries;
}

function readSnapshotEnvelope(
  body: unknown,
  baseOrigin: string,
): { data: RhqSnapshot; dry_run?: boolean; mode?: string } | null {
  if (!isRecord(body) || !isRecord(body.data)) return null;
  const d = body.data;
  const counts = d.counts;
  const links = d.links;
  const result = d.result;
  const errorEntries = readSnapshotErrors(d.errors);
  if (
    !isString(d.period) ||
    !isString(d.status) ||
    !STATUSES.has(d.status) ||
    !isNullableString(d.rejection_code) ||
    !isNullableInt(d.import_id) ||
    !isNullableString(d.refund_cutoff_at) ||
    !isString(d.received_at) ||
    !isRecord(counts) ||
    !isInt(counts.rows) ||
    !isInt(counts.errors) ||
    !isInt(counts.warnings) ||
    errorEntries === null ||
    !isRecord(links) ||
    !isString(links.self) ||
    (result !== undefined &&
      result !== "created" &&
      result !== "replaced" &&
      result !== "unchanged")
  ) {
    return null;
  }
  const snapshot: RhqSnapshot = {
    period: d.period,
    status: d.status as SnapshotStatus,
    rejection_code: d.rejection_code as string | null,
    import_id: d.import_id as number | null,
    refund_cutoff_at: d.refund_cutoff_at as string | null,
    received_at: d.received_at,
    counts: {
      rows: counts.rows,
      errors: counts.errors,
      warnings: counts.warnings,
    },
    errors: messagesByKey(errorEntries),
    errorEntries,
    errors_truncated: d.errors_truncated === true,
    hold_back_reasons: Array.isArray(d.hold_back_reasons)
      ? d.hold_back_reasons.filter(
          (r): r is string => isString(r) && CODE.test(r),
        )
      : [],
    links: { self: links.self, import: importLink(links.import, baseOrigin) },
  };
  if (result !== undefined) snapshot.result = result;
  if ("payload_sha256" in d) {
    snapshot.payload_sha256 =
      isString(d.payload_sha256) && SHA256_HEX.test(d.payload_sha256)
        ? d.payload_sha256
        : null;
  }
  return {
    data: snapshot,
    dry_run: body.dry_run === true ? true : undefined,
    mode: isString(body.mode) ? body.mode : undefined,
  };
}

/**
 * The import page link, only on the API's own origin. RHQ builds it from its
 * configured address, the host the base URL names; anywhere else is not a
 * page this plugin should send anyone to, so it reads as no link.
 */
function importLink(value: unknown, baseOrigin: string): string | null {
  if (!isString(value)) return null;
  try {
    const url = new URL(value);
    return url.origin === baseOrigin ? url.href : null;
  } catch {
    return null;
  }
}

function messagesByKey(entries: RhqErrorEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { key, message } of entries) (out[key] ??= []).push(message);
  return out;
}

/**
 * A problem+json body RHQ wrote, or null. The content type is required:
 * a JSON error from something else (a proxy, a framework default page)
 * must not be mistaken for one of RHQ's codes, which the push step acts on.
 */
function parseProblem(answer: Answer): RhqProblem | null {
  const type = answer.headers.get("content-type") ?? "";
  if (!/^application\/problem\+json\b/i.test(type.trim())) return null;
  const body = parseJson(answer.text);
  if (
    !isRecord(body) ||
    !isString(body.code) ||
    !/^[a-z0-9_]+$/.test(body.code) ||
    !isString(body.title)
  ) {
    return null;
  }
  const problem: RhqProblem = {
    code: body.code,
    title: body.title,
    detail: isString(body.detail) ? body.detail : null,
    status: answer.status,
  };
  if (isErrorMessages(body.errors)) problem.errors = body.errors;
  if (body.import_id === null || isInt(body.import_id))
    problem.importId = body.import_id;
  if (Array.isArray(body.import_ids) && body.import_ids.every(isInt))
    problem.importIds = body.import_ids;
  if (body.mode === "test") problem.mode = "test";
  if (body.dry_run === true) problem.dryRun = true;
  if (body.errors_truncated === true) {
    problem.errorsTruncated = true;
    if (isInt(body.errors_total)) problem.errorsTotal = body.errors_total;
  }
  return problem;
}

function codeOf(answer: Answer): string | null {
  if (answer.status < 400) return null;
  return parseProblem(answer)?.code ?? "unexpected_response";
}

/** A failure before any HTTP answer, in RhqProblem's shape. */
/** The answer was bigger than any RHQ answer can be; reading stopped. */
class ResponseTooLargeError extends Error {
  name = "ResponseTooLargeError";
  constructor(readonly status: number) {
    super("Response exceeds the size limit");
  }
}

function localProblem(error: unknown, timeoutMs: number): RhqProblem {
  if (error instanceof ResponseTooLargeError) {
    return {
      code: "response_too_large",
      title: "Royalties HQ's answer was too large",
      detail:
        "The answer was over 1 MiB, which no Royalties HQ answer is, so the API base URL is probably wrong. Check it in Royalties HQ.",
      status: error.status,
    };
  }
  if (error instanceof UnsafeDestinationError) {
    return {
      code: "unsafe_destination",
      title: "That address is not allowed",
      detail:
        "The Royalties HQ URL must be a public https:// address. Check the API base URL.",
      status: null,
    };
  }
  if (error instanceof UnexpectedRedirectError) {
    return {
      code: "unexpected_redirect",
      title: "Royalties HQ redirected the request",
      detail:
        "The Royalties HQ API never redirects, so the API base URL is probably wrong. Check it in Royalties HQ.",
      status: error.status,
    };
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return {
      code: "timeout",
      title: "Royalties HQ did not answer in time",
      detail: `No answer within ${Math.round(timeoutMs / 1000)} seconds. It will be tried again.`,
      status: null,
    };
  }
  // The error's own message is not passed on: it can quote the URL, and
  // socket errors are not written for store owners.
  return {
    code: "network_error",
    title: "Could not reach Royalties HQ",
    detail:
      "The connection failed before Royalties HQ answered. Check the API base URL; if it is right, it will be tried again.",
    status: null,
  };
}
