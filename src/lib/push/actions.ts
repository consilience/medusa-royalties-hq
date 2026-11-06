import { checkStagedImports, MANUAL_CHECK_INTERVAL_MS, type ImportCheckOutcome } from "./importStatus"
import { pushPeriod, type PushDeps, type PushOutcome } from "./push"

// The status page's Validate, Push now and Check RHQ status, on the push
// step.
//
// They run inline, in the admin request, rather than through a job: the
// person pressed a button and is waiting for RHQ's answer, which RHQ gives
// within its 60 s client timeout. It is still the scheduler's code path
// (pushPeriod), and the push lock keeps it from overlapping a scheduled push
// in any process. A Push now that fails for a retryable reason is not
// retried by itself: the person sees the answer, and the schedule tries
// again anyway.

export type SnapshotActionResult =
  | { ok: true; message: string; attemptId: string | null }
  | { ok: false; attemptId: string | null; problem: { code: string; title: string; detail: string | null; httpStatus: number | null } }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function message(outcome: Extract<PushOutcome, { kind: "accepted" }>): string {
  const rows = plural(outcome.rowCount, "row")
  let text: string
  if (outcome.mode === "dry_run") text = `Royalties HQ checked ${rows} and would accept them. Nothing was saved (dry run).`
  else if (outcome.mode === "test") text = `Test-mode token: Royalties HQ checked ${rows} and kept nothing. The month is not marked as sent.`
  else if (outcome.result === "unchanged") text = `Royalties HQ already has exactly these ${rows}; nothing changed.`
  else text = `Sent ${rows} to Royalties HQ (${outcome.result}). It is staged there for review before it is imported.`
  if (outcome.ignoredMoneyOnlyRefunds > 0) {
    text += ` ${plural(outcome.ignoredMoneyOnlyRefunds, "refund")} of money outside any product line ${outcome.ignoredMoneyOnlyRefunds === 1 ? "was" : "were"} ignored for royalties; see the attempt for which.`
  }
  return text
}

export function toActionResult(outcome: PushOutcome): SnapshotActionResult {
  switch (outcome.kind) {
    case "accepted":
      return { ok: true, message: message(outcome), attemptId: outcome.attemptId }
    case "skipped":
      return { ok: true, message: "Nothing new to send for this month.", attemptId: null }
    case "busy":
      return {
        ok: false,
        attemptId: null,
        problem: { code: "push_in_progress", title: "A push for this store is already running", detail: "Wait a minute and try again.", httpStatus: null },
      }
    case "refused":
    case "problem":
      return {
        ok: false,
        attemptId: outcome.attemptId,
        problem: { code: outcome.problem.code, title: outcome.problem.title, detail: outcome.problem.detail, httpStatus: outcome.problem.status },
      }
  }
}

function checkResult(outcome: ImportCheckOutcome): SnapshotActionResult {
  const problem = outcome.kind === "refused" ? outcome.problem : outcome.failed
  if (problem) return { ok: false, attemptId: null, problem: { code: problem.code, title: problem.title, detail: problem.detail, httpStatus: problem.status } }
  const n = outcome.kind === "checked" ? outcome.periods.length : 0
  return {
    ok: true,
    attemptId: null,
    message: n === 0 ? "Checked Royalties HQ: no month is waiting there as a staged import." : `Checked ${plural(n, "staged month")} in Royalties HQ.`,
  }
}

export function createSnapshotActions(deps: PushDeps) {
  return {
    async validate(period: string): Promise<SnapshotActionResult> {
      return toActionResult(await pushPeriod(deps, period, { mode: "validate", trigger: "manual" }))
    },
    async push(period: string): Promise<SnapshotActionResult> {
      return toActionResult(await pushPeriod(deps, period, { mode: "live", trigger: "manual" }))
    },
    async checkImports(): Promise<SnapshotActionResult> {
      const now = (deps.now ?? (() => new Date()))()
      // Claimed before anything else, failures included: a press that fails
      // (RHQ down, a bad token) must not be repeatable in a loop against
      // RHQ's read limit either.
      if (!(await deps.store.claimManualCheck(now, MANUAL_CHECK_INTERVAL_MS))) {
        return {
          ok: false,
          attemptId: null,
          problem: { code: "check_rate_limited", title: "Checked less than a minute ago", detail: "Royalties HQ can be asked once a minute. Wait a moment and try again.", httpStatus: null },
        }
      }
      return checkResult(await checkStagedImports(deps, { trigger: "manual" }))
    },
  }
}
