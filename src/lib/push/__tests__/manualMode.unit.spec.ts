import { manuallyPushableMonths } from "../manualPush"
import { pushPeriod } from "../push"
import { accepted, pushWorld, rhqStub, type RhqStub } from "./support/world"

// Manual push mode: nothing goes until a person pushes a
// month, oldest first; a month's cut-off is the moment it is first pushed.

const scheduled = { mode: "live", trigger: "scheduled" } as const
const manual = { mode: "live", trigger: "manual" } as const
const validate = { mode: "validate", trigger: "manual" } as const
const manualSettings = { push_mode: "manual" as const }

function sentBody(rhq: RhqStub, index = 0) {
  const put = rhq.sent.filter((r) => r.method !== "GET")[index]!
  return JSON.parse(put.body!) as { period: string; settings: { refund_cutoff_at: string; push_mode: string } }
}

describe("manual push mode", () => {
  it("sends nothing on the schedule", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq, settings: manualSettings })
    expect(await pushPeriod(w.deps, "2026-07", scheduled)).toEqual({ kind: "skipped", reason: "manual_mode" })
    expect(rhq.sent).toEqual([])
    expect(w.store.data.attempts).toEqual([])
  })

  it("pushes the oldest month with the push time as its cut-off, and records it", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" })] })
    const w = pushWorld({ rhq, settings: manualSettings })
    w.setNow("2026-09-20T12:34:56.000Z")
    expect(await pushPeriod(w.deps, "2026-07", manual)).toMatchObject({ kind: "accepted" })
    expect(sentBody(rhq).settings).toMatchObject({ push_mode: "manual", refund_cutoff_at: "2026-09-20T13:34:56+01:00" })
    const log = await w.store.findSnapshot({ connectionId: 7, period: "2026-07", mode: "live" })
    expect(log!.refund_cutoff_at.toISOString()).toBe("2026-09-20T12:34:56.000Z")
  })

  it("refuses a month while an earlier one is unpushed, sending nothing", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq, settings: manualSettings })
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "refused", problem: { code: "earlier_month_unpushed" } })
    expect(rhq.sent.filter((r) => r.method !== "GET")).toEqual([])
    // The person sees the refusal on the page; nothing else needs telling.
    expect(w.notices).toEqual([])
  })

  it("starts at the start month setting: nothing earlier is offered, and that month goes first", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq, settings: { ...manualSettings, start_month: "2026-08" } })
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "accepted" })
    expect(await pushPeriod(w.deps, "2026-07", manual)).toMatchObject({ kind: "refused", problem: { code: "month_not_pushable" } })
  })

  it("re-pushes an accepted month with the cut-off recorded at its first push", async () => {
    const rhq = rhqStub({
      writes: [accepted("created", { period: "2026-07" }), accepted("created", { period: "2026-08" }), accepted("replaced", { period: "2026-07" })],
    })
    const w = pushWorld({ rhq, settings: manualSettings })
    w.setNow("2026-09-20T12:00:00.000Z")
    await pushPeriod(w.deps, "2026-07", manual)
    w.setNow("2026-09-21T12:00:00.000Z")
    // Pushable once July has gone.
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "accepted" })
    expect(sentBody(rhq, 1).settings.refund_cutoff_at).toBe("2026-09-21T13:00:00+01:00")
    w.setNow("2026-09-25T12:00:00.000Z")
    await pushPeriod(w.deps, "2026-07", manual)
    expect(sentBody(rhq, 2).settings.refund_cutoff_at).toBe("2026-09-20T13:00:00+01:00")
  })

  it("validates any ended month, with the time of the check as its cut-off", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-08", import_id: null })] })
    const w = pushWorld({ rhq, settings: manualSettings })
    w.setNow("2026-09-20T12:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", validate)).toMatchObject({ kind: "accepted", mode: "dry_run" })
    expect(sentBody(rhq).settings.refund_cutoff_at).toBe("2026-09-20T13:00:00+01:00")
  })
})

describe("manuallyPushableMonths", () => {
  it("offers every month from the start month: Medusa's orders are read when a month is built", async () => {
    const w = pushWorld({ rhq: rhqStub({}) })
    expect(await manuallyPushableMonths(w.store, { connectionId: 7, timezone: "Europe/London", startMonth: "2026-07" }, new Date("2026-09-20T12:00:00Z"))).toEqual({
      pushable: ["2026-07"],
      firstUnpushed: "2026-07",
    })
  })

  it("without a start month and nothing pushed, offers only last month", async () => {
    const w = pushWorld({ rhq: rhqStub({}) })
    expect(await manuallyPushableMonths(w.store, { connectionId: 7, timezone: "Europe/London" }, new Date("2026-09-20T12:00:00Z"))).toEqual({
      pushable: ["2026-08"],
      firstUnpushed: "2026-08",
    })
  })
})
