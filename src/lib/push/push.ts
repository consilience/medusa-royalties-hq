import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"

import { parseDecimal } from "../../core/money"
import { buildSnapshot, MAX_SNAPSHOT_ROWS, moneyByCurrency, type BuildSnapshotInput, type BuildSnapshotResult, type PayloadV1 } from "../../core/payload"
import { manualCutoffAt, refundCutoffFor, type Period } from "../../core/period"
import { addMinutesInZone } from "../../core/period/period"
import type { CoreOrder, ProductConfig } from "../../core/types"
import { checkDeployment, type DeploymentRecord } from "../deployment/guard"
import { payloadHash } from "../hash/payloadHash"
import { storeIdOf } from "../medusa/store"
import { CLIENT_VERSION } from "../rhq/clientInfo"
import {
  createRhqClient,
  isLiveAcceptance,
  type ApiLimitKey,
  type RhqClientOptions,
  type RhqConnection,
  type RhqProblem,
  type RhqSnapshot,
  type SnapshotStatus as RhqSnapshotStatus,
  type SnapshotWriteOutcome,
} from "../rhq/client"
import { nextAttempt, type RetryState } from "../rhq/retry"
import { toCoreSettings, type StoredSettings } from "../settings/settings"
import { pushHistory, type PushHistory } from "./log"
import { manuallyPushableMonths } from "./manualPush"
import { STATE_KEYS, type AcceptanceManifest, type ConnectionRecord, type AttemptMode, type PushStore, type SnapshotPatch, type SnapshotStatus, type StoredSaleContext } from "./store"

// The push step: one period, built from the store's orders, sent to RHQ, and
// recorded.
//
// Every live push goes through this one function, scheduled or Push now, so
// the enable switch, the cut-off rule and the bookkeeping cannot differ
// between them. Validate (a dry run) shares the build and send but records
// only its attempt: RHQ keeps nothing from it.

/** Shaped like Medusa's Modules.LOCKING service. */
export type PushLock = {
  execute<T>(key: string, job: () => Promise<T>, args?: { timeout?: number; expire?: number }): Promise<T>
}

/** Structured events only. Nothing logged carries a token, an order's data or a customer's. */
export type PushLogger = (event: Record<string, unknown>) => void

/**
 * Reads the month's orders and product configs. `refundCutoffAt` bounds the
 * refunds to read: the same cut-off the core attributes them with.
 * `saleContexts` gives each order its recorded context on this connection.
 */
export type LoadPeriodInputs = (args: {
  period: Period
  settings: StoredSettings
  refundCutoffAt: string
  history: PushHistory
  saleContexts: (orderIds: readonly string[]) => Promise<Map<string, StoredSaleContext>>
}) => Promise<{
  orders: CoreOrder[]
  orphanRefunds: BuildSnapshotInput["orphanRefunds"]
  refundsOnUnpaidOrders?: number
  products: ReadonlyMap<string, ProductConfig>
}>

/** What a live attempt tells the notifier. Totals and counts only: no rows, no order data. */
export interface PushNotice {
  attemptId: string
  period: string
  kind: "accepted" | "problem"
  rowCount: number | null
  totals: Record<string, string> | null
  problem: PushProblem | null
  stop: boolean
  retryAt: Date | null
  holdBackReasons: string[]
  importUrl: string | null
}

export interface PushDeps {
  store: PushStore
  lock: PushLock
  loadPeriodInputs: LoadPeriodInputs
  /** The RHQ token (environment or sealed); null when none is set. Throws when the sealed one cannot be opened. */
  token: () => Promise<string | null>
  /** The Medusa store's id; null when it cannot be read. */
  storeId: string | null
  /** This deployment's origin (deploymentOrigin). */
  deployment: { origin: string | null }
  /**
   * The first month manual mode offers. Until the start-month setting
   * exists, the connection's backfill start stands in.
   */
  startMonth?: Period
  /** RHQ transport, clock and handshake cache; the defaults are the real ones. */
  rhq?: Omit<RhqClientOptions, "baseUrl" | "token" | "storeId">
  now?: () => Date
  /** For the retry policy's jitter. */
  random?: () => number
  logger?: PushLogger
  notify?: (notice: PushNotice) => Promise<void> | void
}

export interface PushOptions {
  mode: "live" | "validate"
  trigger: "scheduled" | "manual"
  /**
   * Scheduled retries only: the logical push this attempt continues, so the
   * 24 h budget spans them all.
   */
  retry?: RetryState
}

/** A failure in RhqProblem's shape; local ones have a null status. */
export type PushProblem = RhqProblem

export type PushOutcome =
  | {
      kind: "accepted"
      attemptId: string
      mode: AttemptMode
      /** "confirmed": the answer was unreadable, and reading the month back showed RHQ holds what was sent. */
      result: "created" | "replaced" | "unchanged" | "confirmed"
      importId: number | null
      rowCount: number
      ignoredMoneyOnlyRefunds: number
    }
  /** Nothing sent: a scheduled push with nothing new to say. */
  | { kind: "skipped"; reason: "unchanged" | "already_rejected" | "imported" | "before_backfill_start" | "manual_mode" }
  /** Refused locally before anything was sent; an attempt row says why. */
  | { kind: "refused"; attemptId: string; problem: PushProblem }
  /** Another push of this store is running. */
  | { kind: "busy" }
  | {
      kind: "problem"
      attemptId: string
      problem: PushProblem
      /** When to try again (scheduled pushes only); null: do not. */
      retryAt: Date | null
      /**
       * "period": about this month's data (the next month may still go);
       * "connection": about the URL, token or service (every month would
       * fail the same way, so a run stops).
       */
      scope: "period" | "connection"
      /** Needs a person: the run stops and nothing retries until someone acts. */
      stop: boolean
      /** The logical push's retry state after this attempt. */
      retry: RetryState
    }

/** One store, one push at a time, across every process sharing the locking provider. */
export const PUSH_LOCK_KEY = "royalties-hq:push"
// Never wait: a busy lock means someone is pushing right now, and the
// caller says so (Push now) or comes back on a later tick, rather than
// queueing a second push of the same data. Medusa's providers clamp the
// wait to at least a second, which is as close to "never" as they go.
const LOCK_WAIT_SECONDS = 1
// Outlives the RHQ client's 60 s timeout with room for the build, so a dead
// process frees the store within minutes.
const LOCK_EXPIRE_SECONDS = 120

// Problems about one month's content or state, as opposed to the
// connection. After one of these a scheduled run moves on to the next month;
// after anything else it stops, so a revoked token is one notice, not one
// per month.
const PERIOD_CODES: ReadonlySet<string> = new Set(["validation_failed", "duplicate_period", "period_committed", "period_not_ended", "payload_too_large", "too_many_rows"])

// RHQ's (or our own size limit's) verdict on this month's CONTENT: the same
// bytes will be refused the same way, so only these are recorded as
// "rejected". Everything else says nothing about the data and is "failed":
// the same content must go out once it is fixed, never be skipped as if RHQ
// had refused it.
const CONTENT_REJECTION_CODES: ReadonlySet<string> = new Set(["validation_failed", "duplicate_period", "too_many_rows", "payload_too_large"])

// Size refusals leave nothing in RHQ, so the handshake can never list them
// as rejected. The size of given bytes cannot change, so for these the same
// hash alone is enough to skip.
const SIZE_CODES: ReadonlySet<string> = new Set(["too_many_rows", "payload_too_large"])

// period_committed is not about content either, but it is RHQ's final word
// on the month, so it is recorded as rejected.
const REJECTED_CODES: ReadonlySet<string> = new Set([...CONTENT_REJECTION_CODES, "period_committed"])

// Answers no retry and no next month can change: the connection belongs to
// another store or platform, or the month is closed in RHQ. A person acts
// (in RHQ or here) before anything more is sent.
const STOP_CODES: ReadonlySet<string> = new Set(["store_mismatch", "platform_mismatch", "period_committed"])

// A 422 on one of these says the row builder produced a wrong number, not
// that the store's data is unusual. Every later month would come out of the
// same builder, so the run stops rather than moving on.
const BUILDER_FIELD = /^rows\.\d+\.(royalty_on_sales|royalty_on_refunds|list_price|units_sold|units_refunded|breakdown)(\.|$)/

// How far RHQ's clock may run behind ours when matching a month read back
// after an unreadable 2xx from an install that sends no payload_sha256.
// Wrongly refusing a match costs one re-send; wrongly accepting one would
// record content RHQ does not hold, so it is kept small.
const CONFIRM_CLOCK_SKEW_MS = 30_000

// Failures that can follow a 2xx's headers: RHQ may have stored the month
// even though its answer never arrived whole, so the month is read back.
const UNREADABLE_ANSWER_CODES: ReadonlySet<string> = new Set(["unexpected_response", "network_error", "timeout", "response_too_large"])

/**
 * An attempt still open this long was left by a process that died mid-push
 * (a push takes seconds; RHQ's client timeout is 60 s). Long enough that a
 * push running in another, live process is never cut off.
 */
export const INTERRUPTED_AFTER_MS = 15 * 60_000

type Limits = Partial<Record<ApiLimitKey, number>>

/**
 * The install's size limits checked before sending, so a
 * month RHQ would refuse with 413 is refused here, with nothing sent. Counted
 * as RHQ counts: every `,` `[` `{` in the JSON bytes, inside strings too.
 * A limit the install does not report is not checked: RHQ still enforces it.
 */
function sizeRefusal(json: string, wire: number, gzip: boolean, limits: Limits): string | null {
  let values = 0
  let containers = 0
  for (let i = 0; i < json.length; i += 1) {
    const c = json.charCodeAt(i)
    if (c === 0x5b || c === 0x7b) {
      containers += 1
      values += 1
    } else if (c === 0x2c) values += 1
  }
  const bytes = Buffer.byteLength(json, "utf8")
  const over = (n: number, limit: number | undefined) => limit !== undefined && n > limit
  if (over(wire, limits.max_body_bytes)) return `${wire} bytes; Royalties HQ accepts at most ${limits.max_body_bytes}`
  if (gzip && over(bytes, limits.max_inflated_body_bytes)) return `${bytes} bytes once inflated; Royalties HQ accepts at most ${limits.max_inflated_body_bytes}`
  if (over(values, limits.max_json_values)) return `${values} JSON values; Royalties HQ accepts at most ${limits.max_json_values}`
  if (over(containers, limits.max_json_containers)) return `${containers} JSON arrays and objects; Royalties HQ accepts at most ${limits.max_json_containers}`
  return null
}

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

const problemOf = (code: string, title: string, detail: string | null): PushProblem => ({ code, title, detail, status: null })

// The error's own words only: never the object, whose fields could hold
// whatever the reader was looking at.
function shortError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error").slice(0, 500)
}

function isStop(problem: PushProblem): boolean {
  if (STOP_CODES.has(problem.code)) return true
  return problem.status === 422 && Object.keys(problem.errors ?? {}).some((k) => BUILDER_FIELD.test(k))
}

const defaultLogger: PushLogger = (event) => console.warn(JSON.stringify(event))

async function safeNotify(deps: PushDeps, notice: PushNotice): Promise<void> {
  if (!deps.notify) return
  // A notice that cannot be sent never undoes or retries the push it is about.
  try {
    await deps.notify(notice)
  } catch (error) {
    ;(deps.logger ?? defaultLogger)({ event: "push.notify_failed", attemptId: notice.attemptId, error: shortError(error) })
  }
}

/**
 * Pushes (or validates) one period and records what happened. Never throws
 * for an outcome RHQ or the network can produce: those are values the caller
 * acts on. Throws only for a programming error or a store failure.
 */
export async function pushPeriod(deps: PushDeps, period: Period, options: PushOptions): Promise<PushOutcome> {
  const { store } = deps
  const clock = deps.now ?? (() => new Date())
  const settings = await store.currentSettings()
  const baseMode: AttemptMode = options.mode === "validate" ? "dry_run" : "live"

  const refuse = async (problem: PushProblem): Promise<Extract<PushOutcome, { kind: "refused" }>> => {
    const at = clock()
    const attempt = await store.createAttempt({
      period,
      mode: baseMode,
      trigger: options.trigger,
      state: "refused",
      started_at: at,
      finished_at: at,
      problem_code: problem.code,
      problem_title: problem.title.slice(0, 255),
      problem_detail: problem.detail,
    })
    // A person pressing a button sees the refusal; the schedule has nobody
    // watching, so it says so (once per code: the notifier dedupes).
    if (options.trigger === "scheduled" && options.mode === "live") {
      await safeNotify(deps, { attemptId: attempt.id, period, kind: "problem", rowCount: null, totals: null, problem, stop: true, retryAt: null, holdBackReasons: [], importUrl: null })
    }
    return { kind: "refused", attemptId: attempt.id, problem }
  }

  // The enable switch binds live pushes only. A dry run reaches nothing RHQ
  // keeps, and is most useful exactly while sending is off, but it still
  // needs somewhere to send to.
  if (settings === null) return refuse(problemOf("not_configured", "Not configured", "Save the settings before pushing."))
  if (options.mode === "live" && !settings.enabled) {
    return refuse(problemOf("disabled", "Sending to Royalties HQ is switched off", "Turn it on in Settings to push."))
  }
  // Taken before the token is read: a token change from here on may mean
  // this push holds the old token (see the connection record below).
  const tokenReadAt = clock()
  let token: string | null
  try {
    token = await deps.token()
  } catch {
    return refuse(problemOf("token_unreadable", "The saved Royalties HQ token cannot be read", "Enter the API token in Settings again."))
  }
  if (!settings.base_url || !token) {
    return refuse(problemOf("not_connected", "Not connected", "Enter the Royalties HQ API base URL and token in Settings."))
  }

  if (options.mode === "validate") return attemptPush(deps, { settings, token, tokenReadAt, period, options })

  // A copy of the live store (a staging clone, a laptop) carries
  // the same store id and possibly a usable token, so a live push first
  // proves this is the deployment that switched sending on. Once a changed
  // deployment is seen, live pushes stay off until a person confirms the
  // move in the admin, even if the origin later looks right again: an
  // origin that flips back and forth is itself something to look at.
  const deploymentRefusal = await checkDeploymentFor(deps)
  if (deploymentRefusal) return refuse(deploymentRefusal)

  let ran = false
  try {
    return await deps.lock.execute(
      PUSH_LOCK_KEY,
      () => {
        ran = true
        return attemptPush(deps, { settings, token: token!, tokenReadAt, period, options })
      },
      { timeout: LOCK_WAIT_SECONDS, expire: LOCK_EXPIRE_SECONDS },
    )
  } catch (error) {
    // Only a failure to take the lock is "busy"; anything the push itself
    // threw (a store failure) is the caller's to see.
    if (!ran) return { kind: "busy" }
    throw error
  }
}

async function checkDeploymentFor(deps: PushDeps): Promise<PushProblem | null> {
  const { store } = deps
  const hold = await store.readState<{ recordedOrigin: string; currentOrigin: string }>(STATE_KEYS.deploymentHold)
  const changed = (recorded: string, current: string) =>
    problemOf(
      "deployment_changed",
      "This store has moved, or this is a copy of it",
      `Sending was switched on at ${recorded}, but this is ${current}. Live pushes are off until someone confirms the move in Royalties HQ settings; dry runs still work.`,
    )
  if (hold) return changed(hold.recordedOrigin, hold.currentOrigin)
  if (deps.storeId === null) {
    return problemOf("store_id_unknown", "This store's id could not be read", "Royalties HQ needs to know which store is sending; nothing was sent.")
  }
  const recorded = await store.readState<DeploymentRecord>(STATE_KEYS.deployment)
  const check = checkDeployment(recorded, { origin: deps.deployment.origin, storeId: deps.storeId })
  if (check.ok) return null
  if (check.code === "deployment_changed") {
    await store.writeState(STATE_KEYS.deploymentHold, { recordedOrigin: check.recordedOrigin, currentOrigin: check.currentOrigin, at: (deps.now ?? (() => new Date()))().toISOString() })
    return changed(check.recordedOrigin, check.currentOrigin)
  }
  if (check.code === "origin_unknown") {
    return problemOf("origin_unknown", "This deployment's address is not set", "Set the plugin's backendUrl option or MEDUSA_BACKEND_URL, so a copy of this store can be told apart from it.")
  }
  return problemOf("deployment_unrecorded", "Sending has not been switched on here", "Switch sending on in Royalties HQ settings to record this deployment.")
}

interface AttemptArgs {
  settings: StoredSettings
  token: string
  tokenReadAt: Date
  period: Period
  options: PushOptions
}

interface Build {
  built: BuildSnapshotResult
  payload: PayloadV1
  hash: string
}

async function attemptPush(deps: PushDeps, { settings, token, tokenReadAt, period, options }: AttemptArgs): Promise<PushOutcome> {
  const { store } = deps
  const clock = deps.now ?? (() => new Date())
  const log = deps.logger ?? defaultLogger
  const startedAt = clock()
  const core = toCoreSettings(settings)
  const validate = options.mode === "validate"
  const scheduled = options.trigger === "scheduled"
  // Manual push mode: the schedule sends nothing. A push queued before
  // the switch can still reach here once.
  const manualMode = core.pushMode === "manual"
  if (manualMode && scheduled && !validate) return { kind: "skipped", reason: "manual_mode" }

  const client = createRhqClient({
    logger: (entry) => log({ event: "rhq.request", ...entry }),
    ...deps.rhq,
    now: deps.rhq?.now ?? clock,
    baseUrl: settings.base_url!,
    token,
    ...(deps.storeId !== null ? { storeId: storeIdOf(deps.storeId) } : {}),
  })
  const retryState: RetryState = options.retry
    ? { firstAttemptAt: options.retry.firstAttemptAt, attempts: options.retry.attempts + 1 }
    : { firstAttemptAt: startedAt, attempts: 1 }

  // The mode this attempt is recorded under. A test-mode token makes a PUT
  // behave like validate; recording it as "test" is what keeps it from ever
  // counting as pushed.
  const attemptMode = (): AttemptMode => (validate ? "dry_run" : client.mode() === "test" ? "test" : "live")

  const problemArgs = { period, options, startedAt, retryState }

  // Cached (10 min): a run of scheduled pushes asks once. Any write drops the
  // cache, so each later month in the run sees fresh period statuses.
  const handshake = await client.handshake()
  if (!handshake.ok) {
    return recordProblem(deps, { ...problemArgs, connectionId: null, mode: attemptMode(), problem: handshake.problem, build: null })
  }
  const connection = handshake.connection
  const connectionId = connection.id
  if (handshake.mode === "live") {
    await syncFromHandshake(store, connection, clock())
    // For the CSV export, which has no handshake of its own.
    const known = await store.readState<ConnectionRecord>(STATE_KEYS.connection)
    // A token change since this push read its token: its handshake may have
    // used the old one, so it must not confirm the old connection over the
    // change's mark. A change at the same instant counts as since.
    const changedSince = known && "unconfirmed_since" in known && new Date(known.unconfirmed_since) >= tokenReadAt
    if (!changedSince && (!known || !("id" in known) || known.id !== connectionId || known.marketplace !== connection.marketplace)) {
      await store.writeState(STATE_KEYS.connection, { id: connectionId, marketplace: connection.marketplace })
    }
  }
  // What this install supports; an older one lists nothing and gets
  // the oldest behaviour: no store, no gzip, the 3,100-row cap.
  const features = new Set(connection.api?.features ?? [])
  const limits: Limits = connection.api?.limits ?? {}
  const gzip = features.has("gzip")

  const refusedAttempt = async (problem: PushProblem, extra: { importId?: number | null; contentHash?: string } = {}): Promise<Extract<PushOutcome, { kind: "refused" }>> => {
    const attempt = await store.createAttempt({
      connection_id: connectionId,
      period,
      mode: attemptMode(),
      trigger: options.trigger,
      state: "refused",
      started_at: startedAt,
      finished_at: clock(),
      problem_code: problem.code,
      problem_title: problem.title.slice(0, 255),
      problem_detail: problem.detail,
      import_id: extra.importId ?? null,
      content_hash: extra.contentHash ?? null,
    })
    return { kind: "refused", attemptId: attempt.id, problem }
  }

  const rhqPeriod = connection.periods.find((p) => p.period === period)
  if (!validate && rhqPeriod?.status === "imported") {
    // Committed in RHQ: a PUT would get 409 period_committed, which RHQ says
    // never to retry. The schedule moves on; a person is told why.
    if (scheduled) return { kind: "skipped", reason: "imported" }
    return refusedAttempt(
      problemOf(
        "period_imported",
        "Already imported in Royalties HQ",
        `${period} has been imported in Royalties HQ, so it cannot be replaced. Undo that import in Royalties HQ first if it must be sent again; later refunds go into a later month by themselves.`,
      ),
      { importId: rhqPeriod.import_id },
    )
  }

  // Oldest first: a month waits until every earlier one has been
  // accepted, because its refunds are attributed using their cut-offs.
  if (manualMode && !validate) {
    const startMonth = (settings.start_month as Period | null) ?? deps.startMonth ?? connection.backfill_start_month ?? undefined
    const { pushable, firstUnpushed } = await manuallyPushableMonths(store, { connectionId, timezone: core.timezone, startMonth }, clock())
    if (!pushable.includes(period)) {
      return refusedAttempt(
        firstUnpushed !== null && firstUnpushed < period
          ? problemOf("earlier_month_unpushed", "An earlier month has not been sent yet", `Months go to Royalties HQ oldest first. Push ${firstUnpushed} first; ${period} can go once Royalties HQ has accepted it.`)
          : problemOf("month_not_pushable", "This month cannot be sent yet", `${period} has not ended in both your store's time zone and UTC, or an earlier month is still waiting.`),
      )
    }
  }

  // A month before the connection's backfill start is staged but held back
  // for a person, so the schedule leaves it alone; a person who
  // picks it with Push now has chosen to.
  if (scheduled && !validate && connection.backfill_start_month !== null && period < connection.backfill_start_month) {
    return { kind: "skipped", reason: "before_backfill_start" }
  }

  // An install that binds stores must be told which store this is,
  // every time; an unbound push would leave the connection open to any store.
  if (features.has("store_id") && deps.storeId === null) {
    return refusedAttempt(problemOf("store_id_unknown", "This store's id could not be read", "Royalties HQ needs to know which store is sending; nothing was sent."))
  }

  const liveLog = await store.findSnapshot({ connectionId, period, mode: "live" })

  // A live attempt that may have reached RHQ without the store recording the
  // answer (the process died, the answer was lost) is settled first, so the
  // month's history is right before it is rebuilt.
  if (!validate && attemptMode() === "live") await reconcile(deps, client, connectionId, period, liveLog?.pushed_at ?? null, clock)
  const settled = await store.findSnapshot({ connectionId, period, mode: "live" })

  let built: BuildSnapshotResult
  try {
    built = await buildFor(deps, {
      settings,
      period,
      connection,
      connectionId,
      generatedAt: startedAt,
      maxRows: limits.max_rows ?? MAX_SNAPSHOT_ROWS,
      // A manually pushed month's cut-off is when it is first pushed
      // (or checked, for a dry run); a recorded one is kept.
      manualCutoff: manualMode ? manualCutoffAt(startedAt.toISOString(), core.timezone) : undefined,
    })
  } catch (error) {
    // An order or product read that failed, or bad settings. Not an RHQ
    // problem; the next tick builds again.
    log({ event: "push.build_failed", period, error: shortError(error) })
    return recordProblem(deps, {
      ...problemArgs,
      connectionId,
      mode: attemptMode(),
      problem: problemOf("build_failed", "The snapshot could not be built", shortError(error)),
      build: null,
    })
  }

  // The content hash covers store.id with the rest, so a month pushed before
  // the install bound stores looks changed and goes out with its store.
  const hash = payloadHash(JSON.parse(client.bodyFor(built.payload, connection)))
  // Same content as the last accepted live push: send its generated_at, so
  // the bytes match and RHQ answers "unchanged" instead of storing a new
  // version whose only difference is a timestamp.
  const payload: PayloadV1 =
    settled?.pushed_at && settled.content_hash === hash ? { ...built.payload, generated_at: settled.generated_at.toISOString() } : built.payload
  const build: Build = { built, payload, hash }
  // The exact bytes that are hashed, recorded and sent: RHQ's "unchanged"
  // and its payload_sha256 are both of the raw JSON.
  const body = client.bodyFor(payload, connection)
  const tooBig = built.rowCountError ? null : sizeRefusal(body, gzip ? gzipSync(body).length : Buffer.byteLength(body, "utf8"), gzip, limits)
  const locallyRefused = built.rowCountError !== undefined || tooBig !== null

  if (scheduled && !validate && attemptMode() === "live") {
    // The schedule offers every month RHQ has not imported, so a staged month
    // comes round again: only a change is worth a PUT. Push now
    // always sends, which is how a person gets RHQ to look again. Only while
    // RHQ still has an import for it, though: RHQ rebuilds a deleted import
    // on the next push, even of the same bytes.
    if (settled?.status === "staged" && settled.pushed_at && settled.content_hash === hash && rhqPeriod !== undefined && rhqPeriod.import_id !== null) {
      return { kind: "skipped", reason: "unchanged" }
    }
    // Content RHQ refused is refused again tomorrow. But only a refusal of
    // the CONTENT counts, and only while RHQ still holds it as rejected (or,
    // for our own size refusal, while the install's limits still refuse it).
    const last = await store.latestAttempt({ connectionId, period, mode: "live" })
    const code = last?.problem_code ?? ""
    const sizeStillRefused = SIZE_CODES.has(code) && (last?.http_status !== null || locallyRefused)
    if (last?.content_hash === hash && last.state === "rejected" && CONTENT_REJECTION_CODES.has(code) && (sizeStillRefused || rhqPeriod?.status === "rejected")) {
      return { kind: "skipped", reason: "already_rejected" }
    }
  }

  if (scheduled && !validate && attemptMode() === "test") {
    // A test-mode token keeps nothing, so the schedule would send the same
    // month to RHQ's validator every tick while the publisher tries the
    // plugin out. Push now always sends.
    const lastTest = await store.latestAttempt({ connectionId, period, mode: "test" })
    if (lastTest?.content_hash === hash) return { kind: "skipped", reason: "unchanged" }
  }

  if (built.rowCountError) {
    const { rows, max } = built.rowCountError
    return recordProblem(deps, {
      ...problemArgs,
      connectionId,
      mode: attemptMode(),
      problem: problemOf("too_many_rows", "Too many rows for one push", `${period} has ${rows} rows; Royalties HQ accepts at most ${max} in one snapshot. Download the CSV and import it in Royalties HQ instead.`),
      build,
    })
  }
  if (tooBig !== null) {
    return recordProblem(deps, {
      ...problemArgs,
      connectionId,
      mode: attemptMode(),
      problem: problemOf("payload_too_large", "Too large for one push", `${period} comes to ${tooBig} in one snapshot. Download the CSV and import it in Royalties HQ instead.`),
      build,
    })
  }

  // The switch and the push mode were read when the push began, but building
  // can take a while, and a person may change either meanwhile. Read again
  // here, under the lock and right before anything reaches RHQ's import
  // pipeline, so "off" means nothing more goes out.
  if (!validate) {
    const current = await store.currentSettings()
    if (!current?.enabled) {
      return refusedAttempt(problemOf("disabled", "Sending to Royalties HQ was switched off", "Sending was switched off in Settings while this push was being prepared, so nothing was sent."), { contentHash: hash })
    }
    if (scheduled && current.push_mode === "manual") return { kind: "skipped", reason: "manual_mode" }
  }

  const warnings = built.ignoredMoneyOnlyRefunds
  const bodySha = sha256Hex(body)
  const manifest = manifestOf(built, payload, hash)
  // Recorded before sending: if the process dies after RHQ took the
  // body, the next push finds this row and can prove, by RHQ's
  // payload_sha256, that RHQ holds exactly these bytes and this manifest.
  const attempt = await store.createAttempt({
    connection_id: connectionId,
    period,
    mode: attemptMode(),
    trigger: options.trigger,
    state: "prepared",
    started_at: startedAt,
    content_hash: hash,
    body_sha256: bodySha,
    manifest: validate ? null : manifest,
    warnings: warnings.length > 0 ? (warnings as unknown[]) : null,
    retry_count: retryState.attempts,
  })
  await store.updateAttempt(attempt.id, { state: "sent" })

  let outcome: SnapshotWriteOutcome = validate ? await client.validateSnapshot(period, body, { gzip }) : await client.putSnapshot(period, body, { gzip })
  let resultLabel: Extract<PushOutcome, { kind: "accepted" }>["result"] | null = outcome.ok ? outcome.result : null

  // A 2xx whose body could not be read: RHQ may or may not have stored the
  // month. Marking it pushed blindly could record content RHQ never took;
  // calling it a failure and skipping would never send it again. So RHQ is
  // asked what it holds, and only a copy that can only be this push's is
  // taken as accepted. Anything less is "unknown", settled by the next push.
  const unreadable2xx =
    !outcome.ok && !validate && UNREADABLE_ANSWER_CODES.has(outcome.problem.code) && outcome.problem.status !== null && outcome.problem.status >= 200 && outcome.problem.status < 300
  if (unreadable2xx && client.mode() !== "test") {
    const readBack = await client.getSnapshot(period)
    if (readBack.ok && heldByRhq(readBack.snapshot, payload, bodySha, startedAt, settled?.pushed_at ?? null)) {
      outcome = { ok: true, status: 202, result: "replaced", snapshot: readBack.snapshot, mode: "live", dryRun: false }
      resultLabel = "confirmed"
    }
  }

  if (!outcome.ok) {
    return recordProblem(deps, { ...problemArgs, unknown: unreadable2xx, connectionId, mode: attemptMode(), problem: outcome.problem, build, attemptId: attempt.id })
  }

  const finishedAt = clock()
  const result = resultLabel ?? outcome.result
  const attemptResult = {
    state: "accepted" as const,
    finished_at: finishedAt,
    http_status: outcome.status,
    result,
    import_id: outcome.snapshot.import_id,
    // A write can reveal test mode (the answer's marker) after the attempt
    // was created with the token's prefix alone.
    mode: attemptMode(),
  }
  const rowCount = payload.rows.length

  if (!validate && isLiveAcceptance(outcome)) {
    await acceptManifest(store, { connectionId, period, attemptId: attempt.id, attempt: attemptResult, manifest, snapshot: outcome.snapshot, status: outcome.status, unchanged: outcome.result === "unchanged", at: finishedAt })
    await safeNotify(deps, {
      attemptId: attempt.id,
      period,
      kind: "accepted",
      rowCount,
      totals: manifest.totals,
      problem: null,
      stop: false,
      retryAt: null,
      holdBackReasons: outcome.snapshot.hold_back_reasons,
      importUrl: outcome.snapshot.links.import,
    })
  } else {
    await store.updateAttempt(attempt.id, attemptResult)
    if (!validate) {
      // Test mode: kept apart (mode "test", never pushed_at) so the status
      // page can show the dry result without the month looking sent.
      await store.upsertSnapshot(
        { connectionId, period, mode: "test" },
        {
          status: "built",
          refund_cutoff_at: new Date(payload.settings.refund_cutoff_at),
          content_hash: hash,
          generated_at: new Date(payload.generated_at),
          row_count: rowCount,
          totals: manifest.totals,
          last_http_status: outcome.status,
          error_code: null,
        },
        { countAttempt: true },
      )
    }
  }

  return { kind: "accepted", attemptId: attempt.id, mode: attemptResult.mode, result, importId: outcome.snapshot.import_id, rowCount, ignoredMoneyOnlyRefunds: warnings.length }
}

function manifestOf(built: BuildSnapshotResult, payload: PayloadV1, hash: string): AcceptanceManifest {
  return {
    refund_cutoff_at: payload.settings.refund_cutoff_at,
    generated_at: payload.generated_at,
    content_hash: hash,
    row_count: payload.rows.length,
    totals: totalsOf(payload),
    pushed_refund_ids: built.pushedRefundIds,
    reported_money_only_refund_ids: built.reportedMoneyOnlyRefundIds,
    applied_money_only_refund_ids: built.appliedMoneyOnlyRefundIds,
    pushed_order_ids: built.pushedOrderIds,
    refunded_orders_sold_elsewhere: built.refundedOrdersSoldElsewhere,
    sale_contexts: Object.fromEntries(built.capturedSaleContexts),
  }
}

/** Resets what importStatus.ts records about RHQ's view of an import. */
export const RHQ_IMPORT_VIEW_CLEARED = { rhq_error_count: null, rhq_error_summary: null, rhq_error_reason: null, rhq_checked_at: null } as const

/**
 * Records an accepted live push from its manifest, in one atomic write: the
 * store must never say a push was accepted without also saying what it
 * carried (the refund and order ids the next builds rely on, and the sale
 * contexts refunds will mirror).
 */
async function acceptManifest(
  store: PushStore,
  a: {
    connectionId: number
    period: string
    attemptId: string
    attempt: Parameters<PushStore["updateAttempt"]>[1]
    manifest: AcceptanceManifest
    snapshot: RhqSnapshot
    status: number
    unchanged: boolean
    at: Date
  },
): Promise<void> {
  const m = a.manifest
  await store.recordAcceptance({
    connectionId: a.connectionId,
    period: a.period,
    attemptId: a.attemptId,
    attempt: a.attempt,
    snapshot: {
      status: logStatusOf(a.snapshot.status),
      refund_cutoff_at: new Date(m.refund_cutoff_at),
      content_hash: m.content_hash,
      generated_at: new Date(m.generated_at),
      row_count: m.row_count,
      totals: m.totals,
      last_http_status: a.status,
      error_code: null,
      pushed_refund_ids: m.pushed_refund_ids,
      reported_money_only_refund_ids: m.reported_money_only_refund_ids,
      applied_money_only_refund_ids: m.applied_money_only_refund_ids,
      pushed_order_ids: m.pushed_order_ids,
      import_id: a.snapshot.import_id,
      pushed_at: a.at,
      hold_back_reasons: a.snapshot.hold_back_reasons,
      import_url: a.snapshot.links.import,
      payload_sha256: a.snapshot.payload_sha256 ?? null,
      // "unchanged" is the same import, so what RHQ last said about it still
      // holds; anything else is a new import RHQ has not reported on yet.
      ...(a.unchanged ? {} : RHQ_IMPORT_VIEW_CLEARED),
    },
    saleContexts: { captured: m.sale_contexts, pushedOrderIds: m.pushed_order_ids },
    freeze: { orderIds: m.refunded_orders_sold_elsewhere, reason: "refund_reported", at: a.at },
  })
}

/**
 * Settles the latest live attempt that may have reached RHQ unrecorded: sent
 * (the process died before the answer was recorded), unknown (the answer was
 * unreadable) or interrupted. When RHQ's payload_sha256 for the month is the
 * hash of that attempt's body, RHQ holds exactly it, and its manifest is
 * recorded as accepted. Otherwise nothing changes and the push goes ahead,
 * sending again; RHQ answers "unchanged" if the bytes had landed.
 */
async function reconcile(deps: PushDeps, client: ReturnType<typeof createRhqClient>, connectionId: number, period: string, pushedAt: Date | null, clock: () => Date): Promise<void> {
  const { store } = deps
  const open = await store.latestAttempt({ connectionId, period, mode: "live", states: ["sent", "unknown", "interrupted"] })
  if (!open?.body_sha256 || !open.manifest) return
  // Settled already by a later accepted push.
  if (pushedAt && pushedAt >= open.started_at) return
  const readBack = await client.getSnapshot(period)
  if (!readBack.ok) return
  const snap = readBack.snapshot
  if ((snap.status !== "staged" && snap.status !== "imported") || snap.payload_sha256 !== open.body_sha256) return
  const at = clock()
  await acceptManifest(store, {
    connectionId,
    period,
    attemptId: open.id,
    attempt: { state: "accepted", result: "confirmed", finished_at: open.finished_at ?? at, import_id: snap.import_id, problem_code: null, problem_title: null, problem_detail: null },
    manifest: open.manifest,
    snapshot: snap,
    status: 200,
    unchanged: false,
    at,
  })
  ;(deps.logger ?? defaultLogger)({ event: "push.reconciled", period, attemptId: open.id })
}

/**
 * Whether RHQ's current copy of the month (read back after an unreadable
 * 2xx) can only be the push just made. RHQ's receipt (payload_sha256)
 * settles it exactly; null is RHQ saying it holds no receipt, so
 * nothing is proven. Only an install that sends no hash at all falls back to
 * matching when it was received, its cut-off and its row count. The push
 * lock means no other push of this store landed in between.
 */
function heldByRhq(snapshot: RhqSnapshot, sent: PayloadV1, sentSha256: string, startedAt: Date, previousPushAt: Date | null): boolean {
  if (snapshot.status !== "staged" && snapshot.status !== "imported") return false
  if (snapshot.payload_sha256 !== undefined) return snapshot.payload_sha256 === sentSha256
  const received = Date.parse(snapshot.received_at)
  if (Number.isNaN(received)) return false
  if (received < startedAt.getTime() - CONFIRM_CLOCK_SKEW_MS) return false
  if (previousPushAt && received <= previousPushAt.getTime()) return false
  if (snapshot.refund_cutoff_at === null || Date.parse(snapshot.refund_cutoff_at) !== Date.parse(sent.settings.refund_cutoff_at)) return false
  return snapshot.counts.rows === sent.rows.length
}

/** Builds the period from the store's orders with the history RHQ and the log hold. */
async function buildFor(
  deps: PushDeps,
  args: { settings: StoredSettings; period: Period; connection: RhqConnection; connectionId: number; generatedAt: Date; maxRows: number; manualCutoff?: string },
): Promise<BuildSnapshotResult> {
  const core = toCoreSettings(args.settings)
  // RHQ's record wins for cut-offs and what is committed, except for a month
  // it holds only as rejected: that cut-off was sent by a push nothing here
  // accepted, and taking it would freeze a cut-off no accepted push used and
  // treat a month that never went out as pushed (the money-only rule).
  const handshakePeriods = args.connection.periods.filter((p) => p.status !== "rejected")
  const history = pushHistory(await deps.store.listSnapshots(args.connectionId), { connectionId: args.connectionId, handshakePeriods })
  // Instants are stored and sent by RHQ in UTC; what was sent was that
  // instant in the store's zone ("…T00:00:00+01:00"). Rendering it the same
  // way keeps a re-push byte-identical, which RHQ's "unchanged" depends on.
  for (const [p, instant] of history.recordedCutoffs) {
    history.recordedCutoffs.set(p, addMinutesInZone(instant, 0, core.timezone))
  }
  if (args.manualCutoff !== undefined && !history.recordedCutoffs.has(args.period)) {
    history.recordedCutoffs.set(args.period, args.manualCutoff)
  }
  const refundCutoffAt = refundCutoffFor(args.period, core, history.recordedCutoffs)
  const inputs = await deps.loadPeriodInputs({
    period: args.period,
    settings: args.settings,
    refundCutoffAt,
    history,
    saleContexts: (ids) => deps.store.saleContexts(args.connectionId, ids),
  })
  return buildSnapshot({
    period: args.period,
    orders: inputs.orders,
    orphanRefunds: inputs.orphanRefunds,
    refundsOnUnpaidOrders: inputs.refundsOnUnpaidOrders,
    products: inputs.products,
    settings: core,
    ...history,
    generatedAt: args.generatedAt.toISOString(),
    clientVersion: CLIENT_VERSION,
    maxRows: args.maxRows,
    // Every Medusa refund is cash with no lines and no link to a return.
    unlinedRefunds: "infer",
  })
}

/**
 * Brings this connection's live snapshots in line with RHQ's view of each
 * month: the publisher imports, rejects or undoes in RHQ, and
 * only the handshake says so. An import freezes the month's sale contexts in
 * the same write, since the period is committed and its sales will never be
 * sent again.
 */
export async function syncFromHandshake(store: PushStore, connection: RhqConnection, now: Date): Promise<void> {
  const logs = (await store.listSnapshots(connection.id)).filter((l) => l.mode === "live" && l.pushed_at !== null)
  const byPeriod = new Map(logs.map((l) => [l.period, l]))
  for (const p of connection.periods) {
    const log = byPeriod.get(p.period)
    if (!log) continue
    const next = syncedStatus(p.status)
    if (next === null) {
      // A status this plugin does not know: what RHQ said about the import
      // this row last knew of no longer describes the month.
      if (log.rhq_checked_at !== null) await store.updateSnapshot(log.id, RHQ_IMPORT_VIEW_CLEARED)
      continue
    }
    // RHQ's import id is taken as it is, null included: deleting a staged
    // import in RHQ nulls it and leaves the month staged.
    if (next === log.status && p.import_id === log.import_id) continue
    const patch: SnapshotPatch = {
      status: next,
      import_id: p.import_id,
      ...RHQ_IMPORT_VIEW_CLEARED,
      // Only a staged month is held back. The link names the import, so it
      // survives the import itself but not a new or deleted one.
      ...(next === "staged" ? {} : { hold_back_reasons: [] }),
      ...(p.import_id === log.import_id ? {} : { import_url: null }),
    }
    // Exactly what RHQ now holds: the sales the accepted body carried, late
    // ones included. A row without the list (never, for rows this plugin
    // writes) freezes nothing rather than guessing.
    const freeze = next === "imported" && log.status !== "imported" ? { connectionId: connection.id, orderIds: log.pushed_order_ids ?? [], reason: "period_imported" as const, at: now } : null
    await store.syncSnapshot(log.id, patch, freeze)
  }
}

// A status this plugin does not know leaves the row as it is.
function syncedStatus(status: RhqSnapshotStatus): SnapshotStatus | null {
  if (status === "imported" || status === "staged" || status === "rejected") return status
  return null
}

const logStatusOf = (status: RhqSnapshotStatus): SnapshotStatus => syncedStatus(status) ?? "staged"

/** Net royalty per currency, sales and refunds together, as decimal strings. */
function totalsOf(payload: PayloadV1): Record<string, string> {
  const totals = new Map<string, bigint>()
  for (const row of payload.rows) {
    const net = parseDecimal(row.royalty_on_sales, row.currency) + parseDecimal(row.royalty_on_refunds, row.currency)
    totals.set(row.currency, (totals.get(row.currency) ?? 0n) + net)
  }
  return moneyByCurrency(totals)
}

interface ProblemArgs {
  connectionId: number | null
  period: Period
  options: PushOptions
  startedAt: Date
  mode: AttemptMode
  problem: PushProblem
  retryState: RetryState
  /** What was built, when the build got that far. */
  build: Build | null
  /** The in-flight attempt, when one was created before sending. */
  attemptId?: string
  /** RHQ answered 2xx but neither its body nor a read-back settled it. */
  unknown?: boolean
}

/**
 * Records a failed attempt: the attempt, the live snapshot, the retry
 * decision and the notice. Retries are scheduled only for scheduled live
 * pushes; Push now shows its answer to the person who pressed it.
 */
async function recordProblem(deps: PushDeps, args: ProblemArgs): Promise<Extract<PushOutcome, { kind: "problem" }>> {
  const { store } = deps
  const now = (deps.now ?? (() => new Date()))()
  const { problem } = args
  const stop = isStop(problem)
  const decision = nextAttempt(
    args.retryState,
    // An unknown outcome is retried like a lost connection: re-sending the
    // same bytes is safe and is what settles it.
    args.unknown ? { code: "network_error", status: null } : { code: problem.code, status: problem.status, retryAfterSeconds: problem.retryAfterSeconds ?? null },
    now,
    deps.random,
  )
  const scheduleRetry = !stop && "retryAt" in decision && args.options.trigger === "scheduled" && args.mode !== "dry_run"
  const retryAt = scheduleRetry ? decision.retryAt : null
  const state = args.unknown ? "unknown" : REJECTED_CODES.has(problem.code) ? "rejected" : "failed"

  const attemptData = {
    state,
    finished_at: now,
    mode: args.mode,
    http_status: problem.status,
    problem_code: problem.code.slice(0, 64),
    problem_title: problem.title.slice(0, 255),
    problem_detail: problem.detail,
    row_errors: problem.errors ?? null,
    import_id: problem.importId ?? null,
    content_hash: args.build?.hash ?? null,
    retry_at: retryAt,
    retry_count: args.retryState.attempts,
  } as const
  const warnings = args.build?.built.ignoredMoneyOnlyRefunds ?? []
  let attemptId: string
  if (args.attemptId !== undefined) {
    await store.updateAttempt(args.attemptId, attemptData)
    attemptId = args.attemptId
  } else {
    const created = await store.createAttempt({
      ...attemptData,
      connection_id: args.connectionId,
      period: args.period,
      trigger: args.options.trigger,
      started_at: args.startedAt,
      warnings: warnings.length > 0 ? (warnings as unknown[]) : null,
    })
    attemptId = created.id
  }

  if (args.mode === "live" && args.build && args.connectionId !== null) {
    await recordLiveFailure(store, args.connectionId, args.period, problem, args.build)
  }

  if (args.mode === "live") {
    await safeNotify(deps, {
      attemptId,
      period: args.period,
      kind: "problem",
      rowCount: args.build?.payload.rows.length ?? null,
      totals: args.build ? totalsOf(args.build.payload) : null,
      problem,
      stop,
      retryAt,
      holdBackReasons: [],
      importUrl: null,
    })
  }

  return {
    kind: "problem",
    attemptId,
    problem,
    retryAt,
    scope: PERIOD_CODES.has(problem.code) && !stop ? "period" : "connection",
    stop,
    retry: args.retryState,
  }
}

/**
 * The live snapshot after a refused or failed send. A month RHQ already
 * holds (accepted earlier) keeps its accepted content, status and manifests:
 * a failed re-push changed nothing in RHQ, and the next builds must go on
 * using what was accepted. A month never accepted records this try, without
 * pushed_at, so its cut-off is still the schedule's.
 */
async function recordLiveFailure(store: PushStore, connectionId: number, period: Period, problem: PushProblem, build: Build): Promise<void> {
  const key = { connectionId, period, mode: "live" as const }
  const existing = await store.findSnapshot(key)
  const failure = { last_http_status: problem.status, error_code: problem.code.slice(0, 64) }
  if (existing?.pushed_at) {
    await store.updateSnapshot(existing.id, failure, { countAttempt: true })
    return
  }
  // Only a verdict on the content makes the month "rejected"; a 422 such as
  // period_not_ended is about the calendar, not the data.
  const status: SnapshotStatus = CONTENT_REJECTION_CODES.has(problem.code) ? "rejected" : "failed"
  await store.upsertSnapshot(
    key,
    {
      ...failure,
      status,
      refund_cutoff_at: new Date(build.payload.settings.refund_cutoff_at),
      content_hash: build.hash,
      generated_at: new Date(build.payload.generated_at),
      row_count: build.payload.rows.length,
      totals: totalsOf(build.payload),
    },
    { countAttempt: true },
  )
}

/**
 * Closes push attempts a dead process left open, as "interrupted", so the
 * status page stops showing them as in progress. Run when a worker starts.
 * Whether RHQ got the month is unknown; the next push settles it, by RHQ's
 * payload_sha256 or with "unchanged". Returns how many were closed.
 */
export async function markInterruptedAttempts(store: PushStore, now: Date): Promise<number> {
  return store.markInterrupted(new Date(now.getTime() - INTERRUPTED_AFTER_MS), now)
}
