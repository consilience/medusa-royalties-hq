import { pushHistory, type LoggedSnapshot } from "../log"

const row = (over: Partial<LoggedSnapshot>): LoggedSnapshot => ({
  connection_id: 7,
  period: "2026-09",
  mode: "live",
  status: "staged",
  refund_cutoff_at: new Date("2026-10-15T09:00:00Z"),
  pushed_at: new Date("2026-10-15T09:00:05Z"),
  pushed_refund_ids: ["r1"],
  reported_money_only_refund_ids: ["m1"],
  applied_money_only_refund_ids: ["a1"],
  pushed_order_ids: ["o1", "o2"],
  ...over,
})

describe("pushHistory", () => {
  it("reads an accepted live push's cut-off and manifests", () => {
    const h = pushHistory([row({})], { connectionId: 7 })
    expect(h.recordedCutoffs.get("2026-09")).toBe("2026-10-15T09:00:00.000Z")
    expect(h.refundsAlreadyPushed.get("2026-09")).toEqual(new Set(["r1"]))
    expect(h.moneyOnlyRefundsAlreadyReported.get("2026-09")).toEqual(new Set(["m1"]))
    expect(h.appliedMoneyOnlyRefundIds.get("2026-09")).toEqual(new Set(["a1"]))
    expect(h.ordersAlreadyPushed.get("2026-09")).toEqual(new Set(["o1", "o2"]))
    expect(h.committedPeriods.has("2026-09")).toBe(false)
  })

  it("counts an imported month as committed", () => {
    expect(pushHistory([row({ status: "imported" })], { connectionId: 7 }).committedPeriods.has("2026-09")).toBe(true)
  })

  it("ignores another connection's history, so a new connection starts fresh", () => {
    const h = pushHistory([row({ connection_id: 8, status: "imported" })], { connectionId: 7 })
    expect(h.recordedCutoffs.size).toBe(0)
    expect(h.committedPeriods.size).toBe(0)
    expect(h.ordersAlreadyPushed.size).toBe(0)
  })

  it("ignores test-mode pushes, which RHQ never kept", () => {
    const h = pushHistory([row({ mode: "test" })], { connectionId: 7 })
    expect(h.recordedCutoffs.size).toBe(0)
    expect(h.refundsAlreadyPushed.size).toBe(0)
  })

  it("takes nothing from a snapshot RHQ never accepted", () => {
    const h = pushHistory([row({ pushed_at: null, status: "failed" })], { connectionId: 7 })
    expect(h.recordedCutoffs.size).toBe(0)
    expect(h.refundsAlreadyPushed.size).toBe(0)
    expect(h.appliedMoneyOnlyRefundIds.size).toBe(0)
  })

  it("keeps the history of a month RHQ accepted, whatever a later failed re-push left in its status", () => {
    // pushed_at is set only by an acceptance, and a failed re-push keeps the
    // accepted content (recordLiveFailure): RHQ still holds those refunds, so
    // re-sending them would count them twice.
    const h = pushHistory([row({ status: "failed" })], { connectionId: 7 })
    expect(h.recordedCutoffs.has("2026-09")).toBe(true)
    expect(h.refundsAlreadyPushed.get("2026-09")?.size).toBeGreaterThan(0)
  })

  it("leaves a month with no recorded order list as unknown, not empty", () => {
    const h = pushHistory([row({ pushed_order_ids: null })], { connectionId: 7 })
    expect(h.ordersAlreadyPushed.has("2026-09")).toBe(false)
  })

  it("prefers the cut-off RHQ recorded, and RHQ's word that a month is imported", () => {
    const h = pushHistory([row({})], {
      connectionId: 7,
      handshakePeriods: [
        { period: "2026-09", status: "imported", refund_cutoff_at: "2026-10-15T10:00:00+00:00" },
        { period: "2026-08", status: "imported", refund_cutoff_at: "2026-09-15T10:00:00+00:00" },
      ],
    })
    expect(h.recordedCutoffs.get("2026-09")).toBe("2026-10-15T10:00:00.000Z")
    expect([...h.committedPeriods].sort()).toEqual(["2026-08", "2026-09"])
    expect(h.ordersAlreadyPushed.has("2026-08")).toBe(false)
  })

  it("drops a month from committed when RHQ lists it as no longer imported", () => {
    const h = pushHistory([row({ status: "imported" })], {
      connectionId: 7,
      handshakePeriods: [{ period: "2026-09", status: "staged", refund_cutoff_at: "2026-10-15T09:00:00+00:00" }],
    })
    expect(h.committedPeriods.has("2026-09")).toBe(false)
  })
})
