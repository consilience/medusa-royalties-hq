import { createRhqClient, type RhqProblem } from "../rhq/client"
import { summariseImportErrors } from "../rhq/importErrors"
import { storeIdOf } from "../medusa/store"
import { syncFromHandshake, type PushDeps } from "./push"

// RHQ's own view of each staged month's import, kept on the month's live
// snapshot (rhq_error_*, rhq_checked_at) for the status page.
//
// Why it is needed: when committing a staged snapshot fails inside RHQ, RHQ
// keeps the month staged with the same import id (the publisher can retry
// or delete the import there), and says so only in GET
// /sales-snapshots/{period}'s `errors`. The schedule then skips the month as
// unchanged and even Push now gets "unchanged", so nothing this plugin sends
// can fix it. Showing it is the whole job.
//
// When it is asked (RHQ's 120 reads a minute per token): from
// the scheduler, one GET per staged month that has an import, one after
// another; and from the status page, at most once per
// MANUAL_CHECK_INTERVAL_MS. Only months RHQ lists as staged WITH an import
// id are asked about: one without (import deleted in RHQ) has nothing to
// retry, and the next push rebuilds it.

export type ImportCheckDeps = Pick<PushDeps, "store" | "rhq" | "now" | "token" | "logger" | "storeId">

export type ImportCheckOutcome =
  /** `periods`: the months whose view was recorded. `failed`: the GET that stopped the run, if one did. */
  | { kind: "checked"; periods: string[]; failed: RhqProblem | null }
  /** Nothing asked: no connection, an unreadable token or a failed handshake. */
  | { kind: "refused"; problem: RhqProblem }

/** One manual check per store per minute. */
export const MANUAL_CHECK_INTERVAL_MS = 60_000

const refused = (code: string, title: string, detail: string | null): ImportCheckOutcome => ({ kind: "refused", problem: { code, title, detail, status: null } })

export async function checkStagedImports(deps: ImportCheckDeps, options: { trigger: "scheduled" | "manual" }): Promise<ImportCheckOutcome> {
  const { store } = deps
  const clock = deps.now ?? (() => new Date())
  const settings = await store.currentSettings()
  let token: string | null
  try {
    token = await deps.token()
  } catch {
    return refused("token_unreadable", "The saved Royalties HQ token cannot be read", "Enter the API token in Settings again.")
  }
  if (!settings?.base_url || !token) return refused("not_connected", "Royalties HQ is not connected", "Enter the API base URL and token in Settings.")
  const log = deps.logger
  const client = createRhqClient({
    ...(log ? { logger: (entry) => log({ event: "rhq.request", ...entry }) } : {}),
    ...deps.rhq,
    now: deps.rhq?.now ?? clock,
    baseUrl: settings.base_url,
    token,
    ...(deps.storeId ? { storeId: storeIdOf(deps.storeId) } : {}),
  })
  // The scheduler shares the cached handshake with the push that follows
  // it; a person pressing the button wants RHQ's state now.
  const handshake = await client.handshake({ fresh: options.trigger === "manual" })
  if (!handshake.ok) return { kind: "refused", problem: handshake.problem }
  // A test-mode token stages nothing, and live snapshots are not its business.
  if (handshake.mode !== "live") return { kind: "checked", periods: [], failed: null }
  const connection = handshake.connection
  // First bring status and import ids in line, which also clears the view
  // of any month that has moved on (imported, or a new import).
  await syncFromHandshake(store, connection, clock())

  const logs = (await store.listSnapshots(connection.id)).filter((l) => l.mode === "live" && l.status === "staged" && l.pushed_at !== null)
  const byPeriod = new Map(logs.map((l) => [l.period, l]))
  const due = connection.periods
    .filter((p) => p.status === "staged" && p.import_id !== null && byPeriod.get(p.period)?.import_id === p.import_id)
    .sort((a, b) => (a.period < b.period ? -1 : 1))

  const checked: string[] = []
  // Sequential on purpose: a handful of months, and parallel reads would
  // only spend RHQ's rate limit faster.
  for (const p of due) {
    const row = byPeriod.get(p.period)!
    const answer = await client.getSnapshot(p.period)
    if (!answer.ok) {
      // A month RHQ no longer has is that month's business; anything else
      // (rate limit, outage, token) would fail the same way for the rest,
      // so stop and keep what was known.
      if (answer.problem.code === "snapshot_not_found") continue
      return { kind: "checked", periods: checked, failed: answer.problem }
    }
    const snapshot = answer.snapshot
    // Only an answer about the import the row names is recorded; one that
    // moved on since the handshake is left for the next handshake to sync.
    if (snapshot.status !== "staged" || snapshot.import_id !== p.import_id) continue
    const errors = summariseImportErrors(snapshot)
    // Conditional on the import id still matching, so a push that replaced
    // the import while this GET was in flight is never labelled with the
    // old import's failure.
    await store.updateSnapshotIf(
      row.id,
      { import_id: p.import_id, status: "staged" },
      {
        rhq_error_count: errors.count,
        rhq_error_summary: errors.summary,
        rhq_error_reason: errors.reason,
        rhq_checked_at: clock(),
        // Only snapshot answers carry these, and a person may clear a
        // hold-back in RHQ without importing, so each check refreshes them.
        hold_back_reasons: snapshot.hold_back_reasons,
        import_url: snapshot.links.import,
      },
    )
    checked.push(p.period)
  }
  return { kind: "checked", periods: checked, failed: null }
}
