import { addMonths, comparePeriods, periodOfInstant, periodRange, type Period } from "../../core/period"
import { checkDeployment, type DeploymentCheck, type DeploymentRecord } from "../deployment/guard"
import { holdBackText } from "../rhq/holdBack"
import { knownConnection, STATE_KEYS, type AttemptRow, type ConnectionRecord, type PushStore, type SnapshotRow } from "../push/store"
import { PLAN_KEY } from "../push/tick"

type Here = { origin: string | null; storeId: string | null }

export type MonthLine = {
  period: string
  /** RHQ's view of the live snapshot, or null when none was ever accepted. */
  status: SnapshotRow["status"] | null
  row_count: number | null
  totals: Record<string, string> | null
  pushed_at: string | null
  import_url: string | null
  hold_back_reasons: string[]
  /** The reasons in words, for the page. */
  hold_back_notes: string[]
  rhq_error_summary: string | null
  /** The last live or test push. */
  last_attempt: AttemptLine | null
  /** A dry run since that push, if any. */
  last_dry_run: AttemptLine | null
}

type AttemptLine = {
  mode: AttemptRow["mode"]
  trigger: AttemptRow["trigger"]
  state: AttemptRow["state"]
  finished_at: string | null
  problem_code: string | null
  problem_title: string | null
  problem_detail: string | null
  retry_at: string | null
}


const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null)

/**
 * The status page's data. Read-only and local: it never calls RHQ, so the
 * page opens fast and costs RHQ nothing; Check RHQ status is the button for
 * that.
 */
export async function statusView(store: PushStore, at: Here & { now: Date }) {
  const settings = await store.currentSettings()
  const connection = await knownConnection(store)
  const record = await store.readState<ConnectionRecord>(STATE_KEYS.connection)
  const recorded = await store.readState<DeploymentRecord>(STATE_KEYS.deployment)
  const deployment: DeploymentCheck = at.storeId ? checkDeployment(recorded, { origin: at.origin, storeId: at.storeId }) : { ok: false, code: "origin_unknown" }
  const saved = await store.readState<{ at: string; plan: { periods: string[] } }>(PLAN_KEY)

  const snapshots = connection ? (await store.listSnapshots(connection.id)).filter((s) => s.mode === "live") : []
  const byPeriod = new Map(snapshots.map((s) => [s.period, s]))
  const start = settings?.start_month ?? [...byPeriod.keys()].sort()[0] ?? null
  const months: MonthLine[] = []
  if (start && settings?.timezone) {
    const last = addMonths(periodOfInstant(at.now.toISOString(), settings.timezone), -1)
    const periods = comparePeriods(start as Period, last) <= 0 ? periodRange(start as Period, last) : []
    for (const period of periods.reverse()) {
      const s = byPeriod.get(period)
      const [push, dry] = connection ? await latestAttempts(store, connection.id, period) : [null, null]
      months.push({
        period,
        status: s?.pushed_at ? s.status : null,
        row_count: s?.pushed_at ? s.row_count : null,
        totals: s?.pushed_at ? s.totals : null,
        pushed_at: iso(s?.pushed_at),
        import_url: s?.import_url ?? null,
        hold_back_reasons: s?.hold_back_reasons ?? [],
        // Codes this release does not know share one sentence; say it once.
        hold_back_notes: [...new Set((s?.hold_back_reasons ?? []).map(holdBackText))],
        rhq_error_summary: s?.rhq_error_summary ?? null,
        last_attempt: push && attemptLine(push),
        last_dry_run: dry && (!push || startedAt(dry) > startedAt(push)) ? attemptLine(dry) : null,
      })
    }
  }

  return {
    enabled: settings?.enabled ?? false,
    push_mode: settings?.push_mode ?? "automatic",
    connected: connection !== null,
    /** The token changed since the last handshake: Test connection says which connection it belongs to. */
    connection_unconfirmed: record !== null && "unconfirmed_since" in record,
    marketplace: connection?.marketplace ?? null,
    deployment,
    planned: saved ? { at: saved.at, periods: saved.plan.periods } : null,
    months,
  }
}

const startedAt = (a: AttemptRow) => new Date(a.started_at).getTime()

const attemptLine = (a: AttemptRow): AttemptLine => ({
  mode: a.mode,
  trigger: a.trigger,
  state: a.state,
  finished_at: iso(a.finished_at),
  problem_code: a.problem_code,
  problem_title: a.problem_title,
  problem_detail: a.problem_detail,
  retry_at: iso(a.retry_at),
})

// The last push and the last dry run, kept apart: a dry run sends nothing,
// so it must not hide when the month was really sent.
async function latestAttempts(store: PushStore, connectionId: number, period: string): Promise<[AttemptRow | null, AttemptRow | null]> {
  const [live, test, dry] = await Promise.all((["live", "test", "dry_run"] as const).map((mode) => store.latestAttempt({ connectionId, period, mode })))
  const push = [live, test].filter((a): a is AttemptRow => a != null).sort((x, y) => startedAt(y) - startedAt(x))[0] ?? null
  return [push, dry ?? null]
}

/**
 * The first time sending is switched on, this deployment becomes the one
 * allowed to send. Never overwritten here: a copy of the live
 * database that switches sending on must not adopt itself. A real move is
 * confirmed with confirmDeployment.
 */
export async function recordDeploymentOnEnable(store: Pick<PushStore, "readState" | "writeState">, settings: { enabled: boolean }, here: Here) {
  if (!settings.enabled || !here.origin || !here.storeId) return
  if (await store.readState(STATE_KEYS.deployment)) return
  await store.writeState(STATE_KEYS.deployment, { origin: here.origin, storeId: here.storeId })
}

/** A person confirms the store has moved: this deployment sends from now on, and a hold is lifted. */
export async function confirmDeployment(store: Pick<PushStore, "writeState">, here: Here) {
  if (!here.origin || !here.storeId) return false
  await store.writeState(STATE_KEYS.deployment, { origin: here.origin, storeId: here.storeId })
  await store.writeState(STATE_KEYS.deploymentHold, null)
  return true
}

/**
 * A new token may not be the connection the plugin last
 * handshaken with, and the status page, the schedule and the CSV export all
 * read that connection's months. The mark makes them wait for the next
 * handshake (Test connection or a push) rather than show, skip or export by
 * months the new connection never got. A push that began before `at` used
 * the old token, so it leaves the mark alone.
 */
export async function forgetConnection(store: Pick<PushStore, "readState" | "writeState">, at: Date) {
  // Never connected: no history to keep apart, and the export can build
  // from none, as it always has before a first handshake.
  if ((await store.readState(STATE_KEYS.connection)) === null) return
  const mark: ConnectionRecord = { unconfirmed_since: at.toISOString() }
  await store.writeState(STATE_KEYS.connection, mark)
}

type TestedConnection =
  | { ok: true; connection: { id: number; marketplace: string; tokenMode: string } }
  | { ok: false }

/**
 * A successful Test connection confirms the connection. A test token belongs
 * to the same connection as its live one and reads its real state, so its
 * answer confirms it too; otherwise a store on a test token would keep the
 * mark, and a blocked export, for good.
 */
export async function recordTestedConnection(store: Pick<PushStore, "writeState">, result: TestedConnection) {
  if (!result.ok) return
  await store.writeState(STATE_KEYS.connection, { id: result.connection.id, marketplace: result.connection.marketplace })
}
