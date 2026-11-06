import type { Period } from "../../core/period"

/** The rhq_snapshot columns history is derived from. */
export type LoggedSnapshot = {
  connection_id: number
  period: string
  mode: "live" | "test"
  status: "built" | "staged" | "imported" | "rejected" | "failed"
  refund_cutoff_at: Date | string
  pushed_at: Date | string | null
  pushed_refund_ids: string[] | null
  reported_money_only_refund_ids: string[] | null
  applied_money_only_refund_ids: string[] | null
  pushed_order_ids: string[] | null
}

export type HandshakePeriod = { period: string; status: string; refund_cutoff_at: string | null }

export type PushHistory = {
  recordedCutoffs: Map<Period, string>
  committedPeriods: Set<Period>
  refundsAlreadyPushed: Map<Period, Set<string>>
  moneyOnlyRefundsAlreadyReported: Map<Period, Set<string>>
  appliedMoneyOnlyRefundIds: Map<Period, Set<string>>
  ordersAlreadyPushed: Map<Period, Set<string>>
}

const ids = (list: unknown): Set<string> =>
  new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [])

/**
 * What earlier pushes fixed, as the core's history inputs. Only live pushes RHQ
 * accepted on this connection count: a test push is never kept by RHQ, a failed
 * one never reached it, and another connection is another ledger.
 */
export function pushHistory(
  rows: readonly LoggedSnapshot[],
  { connectionId, handshakePeriods = [] }: { connectionId: number; handshakePeriods?: readonly HandshakePeriod[] },
): PushHistory {
  const h: PushHistory = {
    recordedCutoffs: new Map(),
    committedPeriods: new Set(),
    refundsAlreadyPushed: new Map(),
    moneyOnlyRefundsAlreadyReported: new Map(),
    appliedMoneyOnlyRefundIds: new Map(),
    ordersAlreadyPushed: new Map(),
  }
  for (const r of rows) {
    if (r.connection_id !== connectionId || r.mode !== "live" || r.pushed_at == null) continue
    const period = r.period as Period
    h.recordedCutoffs.set(period, new Date(r.refund_cutoff_at).toISOString())
    if (r.status === "imported") h.committedPeriods.add(period)
    h.refundsAlreadyPushed.set(period, ids(r.pushed_refund_ids))
    h.moneyOnlyRefundsAlreadyReported.set(period, ids(r.reported_money_only_refund_ids))
    // Every accepted month gets an entry: the core reads "has an entry" as "the
    // sale period went out", so a refund captured since is not applied to it.
    h.appliedMoneyOnlyRefundIds.set(period, ids(r.applied_money_only_refund_ids))
    // A null list means unknown, and the core must see no entry: an empty set
    // would mean "carried none" and re-book every sale in the month as late.
    if (Array.isArray(r.pushed_order_ids)) h.ordersAlreadyPushed.set(period, ids(r.pushed_order_ids))
  }
  // RHQ is the record: its cut-off and its import status win over
  // ours, whether our row was lost, never updated, or is now stale.
  for (const p of handshakePeriods) {
    const period = p.period as Period
    if (p.refund_cutoff_at) h.recordedCutoffs.set(period, new Date(p.refund_cutoff_at).toISOString())
    // An import undone in RHQ lists the month as staged again; our row may
    // still say imported, but late refunds must go back into that month.
    if (p.status === "imported") h.committedPeriods.add(period)
    else h.committedPeriods.delete(period)
  }
  return h
}
