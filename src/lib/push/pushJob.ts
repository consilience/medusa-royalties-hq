import { isPeriod } from "../../core/period"
import { pushPeriod, type PushDeps } from "./push"

// A scheduled run: the months found due, pushed oldest first, one at a time.
//
// The run owns its retry policy: RHQ's Retry-After and the 24 h budget
// (src/lib/rhq/retry.ts) come back as a plan for later, which the scheduler
// persists. The push lock is held for one attempt only, never across a wait.

export interface PushDuePlan {
  /** Oldest first. */
  periods: string[]
  /** The retry in progress for periods[0], if any. */
  retry?: { period: string; firstAttemptAt: string; attempts: number }
}

/** When to run the rest of the plan; undefined: nothing more until the next tick finds months due. */
export type PushDueResult = { rescheduleAt: Date; plan: PushDuePlan } | undefined

/** While Push now holds the store: soon, since a push takes seconds. */
const BUSY_RETRY_MS = 60_000
/** After a refusal only a person can clear. */
const REFUSED_RETRY_MS = 3_600_000

function readPlan(value: unknown): PushDuePlan {
  const p = value as Partial<PushDuePlan> | null
  if (typeof p !== "object" || p === null || !Array.isArray(p.periods) || !p.periods.every((x) => typeof x === "string" && isPeriod(x))) {
    throw new Error("Push plan is malformed")
  }
  return p as PushDuePlan
}

export async function runPushDue(deps: PushDeps, plan: unknown, signal?: AbortSignal): Promise<PushDueResult> {
  const now = deps.now ?? (() => new Date())
  const { periods, retry } = readPlan(plan)
  for (let i = 0; i < periods.length; i += 1) {
    // Between months is the safe point: a push in flight finishes and is
    // recorded, but a run told to stop starts no further month.
    if (signal?.aborted) return undefined
    const period = periods[i]!
    const remaining = periods.slice(i)
    const carried = retry?.period === period ? { firstAttemptAt: new Date(retry.firstAttemptAt), attempts: retry.attempts } : undefined
    const outcome = await pushPeriod(deps, period, { mode: "live", trigger: "scheduled", retry: carried })
    switch (outcome.kind) {
      case "accepted":
        continue
      case "skipped":
        // Manual mode is the same for every month.
        if (outcome.reason === "manual_mode") return undefined
        continue
      case "busy":
        return { rescheduleAt: new Date(now().getTime() + BUSY_RETRY_MS), plan: { periods: remaining, ...(carried ? { retry: retry! } : {}) } }
      case "refused":
        // Switched off, not connected, a changed deployment: the same for
        // every month, and only a person can fix it. Back in an hour rather
        // than every tick, which would record a refusal every five minutes.
        return { rescheduleAt: new Date(now().getTime() + REFUSED_RETRY_MS), plan: { periods: remaining } }
      case "problem":
        if (outcome.retryAt) {
          return {
            rescheduleAt: outcome.retryAt,
            plan: { periods: remaining, retry: { period, firstAttemptAt: outcome.retry.firstAttemptAt.toISOString(), attempts: outcome.retry.attempts } },
          }
        }
        // This month's data (a rejection): the next month may well go. A
        // stop, or anything about the connection, would fail the same way
        // for each, one notice per month, so the run ends.
        if (outcome.scope === "period" && !outcome.stop) continue
        return undefined
    }
  }
  return undefined
}
