import { PROBLEMS } from "../../rhq/__tests__/support/fakeRhq"
import { STATE_KEYS } from "../store"
import { PLAN_KEY, RECHECK_KEY, runTick, TICK_LOCK_KEY } from "../tick"
import { accepted, pushWorld, rhqStub, type RhqStub } from "./support/world"

// The 5-minute scheduled job's body. Medusa has no job queue, so
// the tick itself decides what is due, runs it, and keeps any retry plan in
// rhq_state for a later tick. "Due" follows the schedule, never the tick:
// the cut-off is the scheduled push moment.

const puts = (rhq: RhqStub) => rhq.sent.filter((r) => r.method === "PUT").map((r) => new URL(r.url).pathname.split("/").pop())

describe("runTick", () => {
  it("in automatic mode pushes every month whose push moment has passed, overdue ones included, oldest first", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" }), accepted("created")] })
    const w = pushWorld({ rhq })
    await runTick(w.deps)
    expect(puts(rhq)).toEqual(["2026-07", "2026-08"])
    expect(await w.store.readState(PLAN_KEY)).toBeNull()
  })

  it("leaves a month whose push moment has not come", async () => {
    // 14 September: August pushes on the 15th, at the store's minute.
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" })] })
    const w = pushWorld({ rhq, now: "2026-09-14T12:00:00.000Z" })
    await runTick(w.deps)
    expect(puts(rhq)).toEqual(["2026-07"])
  })

  it("starts at the start month", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq, settings: { start_month: "2026-08" } })
    await runTick(w.deps)
    expect(puts(rhq)).toEqual(["2026-08"])
  })

  it("sends nothing in manual mode, and drops a retry planned before the switch", async () => {
    const rhq = rhqStub()
    const w = pushWorld({ rhq, settings: { push_mode: "manual" } })
    await w.store.writeState(PLAN_KEY, { at: "2026-09-20T11:00:00.000Z", plan: { periods: ["2026-08"] } })
    await runTick(w.deps)
    expect(rhq.sent).toEqual([])
    expect(await w.store.readState(PLAN_KEY)).toBeNull()
  })

  it("sends nothing while switched off", async () => {
    const rhq = rhqStub()
    const w = pushWorld({ rhq, settings: { enabled: false } })
    await runTick(w.deps)
    expect(rhq.sent).toEqual([])
  })

  it("keeps RHQ's Retry-After for a later tick, and waits for it", async () => {
    const rhq = rhqStub({ writes: [{ status: 429, body: PROBLEMS.rateLimited(), headers: { "Retry-After": "600" } }] })
    const w = pushWorld({ rhq })
    await runTick(w.deps)
    expect(await w.store.readState(PLAN_KEY)).toEqual({
      at: "2026-09-20T12:10:00.000Z",
      plan: { periods: ["2026-07", "2026-08"], retry: { period: "2026-07", firstAttemptAt: "2026-09-20T12:00:00.000Z", attempts: 1 } },
    })
    const sent = rhq.sent.length
    w.setNow("2026-09-20T12:05:00.000Z")
    await runTick(w.deps)
    expect(rhq.sent.length).toBe(sent)

    rhq.state.writes.push(accepted("created", { period: "2026-07" }), accepted("created"))
    w.setNow("2026-09-20T12:10:00.000Z")
    await runTick(w.deps)
    expect(puts(rhq)).toEqual(["2026-07", "2026-07", "2026-08"])
    expect(await w.store.readState(PLAN_KEY)).toBeNull()
  })

  it("re-checks months already sent once a day, not every tick", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" }), accepted("created")] })
    const w = pushWorld({ rhq })
    await runTick(w.deps)
    const sent = rhq.sent.length
    w.setNow("2026-09-20T12:05:00.000Z")
    await runTick(w.deps)
    expect(rhq.sent.length).toBe(sent)
    expect(await w.store.readState(RECHECK_KEY)).toBe("2026-09-21T12:00:00.000Z")

    // A day on: both are rebuilt and found unchanged, so nothing is PUT.
    // RHQ must still hold the imports, or the push step sends again.
    const imports = w.store.data.snapshots.filter((s) => s.mode === "live")
    rhq.state.periods = imports.map((s) => ({ period: s.period, status: "staged", refund_cutoff_at: new Date(s.refund_cutoff_at).toISOString(), import_id: s.import_id! }))
    w.setNow("2026-09-21T12:00:00.000Z")
    const loads = w.loads.length
    await runTick(w.deps)
    expect(w.loads.length).toBeGreaterThan(loads)
    expect(puts(rhq)).toEqual(["2026-07", "2026-08"])
  })

  it("never offers a month RHQ has imported", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" }), accepted("created")] })
    const w = pushWorld({ rhq })
    await runTick(w.deps)
    const conn = (await w.store.readState<{ id: number }>(STATE_KEYS.connection))!.id
    const july = (await w.store.listSnapshots(conn)).find((s) => s.period === "2026-07" && s.mode === "live")!
    await w.store.updateSnapshot(july.id, { status: "imported" })
    w.setNow("2026-09-21T12:00:00.000Z")
    const loads = w.loads.length
    await runTick(w.deps)
    expect(w.loads.slice(loads).map((l) => l.period)).toEqual(["2026-08"])
  })

  it("plans from the start month again after a token change, as with no connection: the new token's history is unknown", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" }), accepted("created")] })
    const w = pushWorld({ rhq })
    await runTick(w.deps)
    w.setNow("2026-09-20T12:05:00.000Z")
    let loads = w.loads.length
    await runTick(w.deps)
    expect(w.loads.length).toBe(loads)
    // A rotated token: the same connection, which lists both months staged.
    const imports = w.store.data.snapshots.filter((s) => s.mode === "live")
    rhq.state.periods = imports.map((s) => ({ period: s.period, status: "staged", refund_cutoff_at: new Date(s.refund_cutoff_at).toISOString(), import_id: s.import_id! }))
    await w.store.writeState(STATE_KEYS.connection, { unconfirmed_since: "2026-09-20T12:04:00.000Z" })
    w.setNow("2026-09-20T12:10:00.000Z")
    loads = w.loads.length
    const sent = puts(rhq).length
    await runTick(w.deps)
    // Both rebuilt and found unchanged: nothing re-sent, and the handshake
    // confirmed the connection again.
    expect(w.loads.slice(loads).map((l) => l.period)).toEqual(["2026-07", "2026-08"])
    expect(puts(rhq).length).toBe(sent)
    expect(await w.store.readState(STATE_KEYS.connection)).toMatchObject({ id: expect.any(Number) })
  })

  it("leaves a month RHQ rejected to the daily recheck, rather than rebuilding it every tick", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" }), accepted("created")] })
    const w = pushWorld({ rhq })
    await runTick(w.deps)
    const conn = (await w.store.readState<{ id: number }>(STATE_KEYS.connection))!.id
    const july = (await w.store.listSnapshots(conn)).find((s) => s.period === "2026-07")!
    // As a content rejection leaves it: rejected, never accepted.
    await w.store.updateSnapshot(july.id, { status: "rejected", pushed_at: null })
    w.setNow("2026-09-20T12:05:00.000Z")
    const loads = w.loads.length
    await runTick(w.deps)
    expect(w.loads.length).toBe(loads)
  })

  it("drops a saved plan it cannot read, and carries on with what is due", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" }), accepted("created")] })
    const w = pushWorld({ rhq })
    await w.store.writeState(PLAN_KEY, { at: "2026-09-20T11:00:00.000Z", plan: { periods: ["July"] } })
    await runTick(w.deps)
    expect(puts(rhq)).toEqual(["2026-07", "2026-08"])
    expect(await w.store.readState(PLAN_KEY)).toBeNull()
  })

  it("does nothing while another tick is running, here or in another process", async () => {
    const rhq = rhqStub()
    const w = pushWorld({ rhq })
    w.lock.held.add(TICK_LOCK_KEY)
    await runTick(w.deps)
    expect(rhq.sent).toEqual([])
  })
})
