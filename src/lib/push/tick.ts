import { isPeriod, periodsDue, type Period, type PeriodStatus } from "../../core/period"
import { runPushDue, type PushDuePlan } from "./pushJob"
import type { PushDeps } from "./push"
import { knownConnection, STATE_KEYS } from "./store"

/** rhq_state: { at, plan } of a run to finish later (a retry, or a busy lock). */
export const PLAN_KEY = "push_plan"
/** rhq_state: when months already sent are next rebuilt to look for late changes. */
export const RECHECK_KEY = "recheck_at"

const DAY_MS = 24 * 3600 * 1000

/**
 * One tick at a time across processes: Medusa's cron fires on every
 * instance, and a daily recheck of many months can outlast five minutes.
 * Two ticks would race on the saved plan and erase each other's retries.
 */
export const TICK_LOCK_KEY = "royalties-hq:tick"
const TICK_LOCK_EXPIRE_SECONDS = 30 * 60

type SavedPlan = { at: string; plan: PushDuePlan }

/**
 * One scheduled tick. Medusa runs scheduled jobs on a fixed cron
 * with no queue behind them, so this keeps its own small plan in rhq_state:
 * a run RHQ asked to come back to waits for that moment, and is never
 * replaced by a fresh one until it has run.
 *
 * A month never sent goes on the first tick after its push moment. A month
 * already sent (staged or rejected in RHQ) may have gained a late refund, but
 * finding out means reading the whole month back from the store, so that
 * happens once a day rather than every five minutes; the push step skips it
 * when nothing changed.
 */
export async function runTick(deps: PushDeps, signal?: AbortSignal): Promise<void> {
  let ran = false
  try {
    await deps.lock.execute(
      TICK_LOCK_KEY,
      () => {
        ran = true
        return tick(deps, signal)
      },
      { timeout: 1, expire: TICK_LOCK_EXPIRE_SECONDS },
    )
  } catch (error) {
    // Busy: the tick holding it does this work.
    if (!ran) return
    throw error
  }
}

async function tick(deps: PushDeps, signal?: AbortSignal): Promise<void> {
  const { store } = deps
  const now = (deps.now ?? (() => new Date()))()
  const settings = await store.currentSettings()
  if (!settings?.enabled || !settings.timezone) return
  if (settings.push_mode === "manual") {
    // Nothing goes until a person pushes; a retry planned before the switch
    // must not fire after it.
    if (await store.readState(PLAN_KEY)) await store.writeState(PLAN_KEY, null)
    return
  }

  let saved = await store.readState<SavedPlan>(PLAN_KEY)
  if (saved && !readable(saved)) {
    // Nothing else would ever clear it, and every tick would throw.
    deps.logger?.({ event: "tick.plan_dropped" })
    await store.writeState(PLAN_KEY, null)
    saved = null
  }
  if (saved && new Date(saved.at) > now) return
  const plan = saved?.plan ?? (await duePlan(deps, settings, now))
  if (!plan) return
  const result = await runPushDue(deps, plan, signal)
  await store.writeState(PLAN_KEY, result ? { at: result.rescheduleAt.toISOString(), plan: result.plan } : null)
}

function readable(saved: SavedPlan): boolean {
  return (
    typeof saved === "object" &&
    !Number.isNaN(new Date(saved.at).getTime()) &&
    Array.isArray(saved.plan?.periods) &&
    saved.plan.periods.every((p) => typeof p === "string" && isPeriod(p))
  )
}

async function duePlan(deps: PushDeps, settings: NonNullable<Awaited<ReturnType<PushDeps["store"]["currentSettings"]>>>, now: Date): Promise<PushDuePlan | null> {
  const { store } = deps
  const start = (settings.start_month ?? deps.startMonth) as Period | undefined
  if (!start) return null

  // Local history is kept in line with RHQ by every handshake (pushes and
  // the daily import check), so the tick needs no request of its own.
  const connection = await knownConnection(store)
  const live = connection ? (await store.listSnapshots(connection.id)).filter((s) => s.mode === "live") : []
  const statuses = new Map<Period, PeriodStatus>()
  const sent = new Set<Period>()
  for (const s of live) {
    if (s.status === "imported") statuses.set(s.period as Period, "imported")
    // Tried already: accepted, or refused by RHQ for its content. Either can
    // only change when the month's orders do, which the daily recheck finds.
    if (s.pushed_at !== null || s.status === "rejected") sent.add(s.period as Period)
  }

  const due = periodsDue(
    now.toISOString(),
    { frequencyMonths: settings.frequency_months, anchorMonth: settings.anchor_month, pushDay: settings.push_day, timezone: settings.timezone! },
    // The push minute is spread by store, so publishers' stores do not all
    // call RHQ at once.
    { storeKey: deps.storeId ?? deps.deployment.origin ?? "medusa", backfillStart: start, statuses },
  )
  const fresh = due.filter((p) => !sent.has(p))
  const recheckAt = await store.readState<string>(RECHECK_KEY)
  const recheck = recheckAt === null || new Date(recheckAt) <= now
  const periods = recheck ? due : fresh
  // Months sent on this pass count as checked today too.
  if (recheck) await store.writeState(RECHECK_KEY, new Date(now.getTime() + DAY_MS).toISOString())
  return periods.length ? { periods } : null
}
