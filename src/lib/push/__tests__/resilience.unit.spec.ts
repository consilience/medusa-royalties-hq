import { PROBLEMS, snapshotData } from "../../rhq/__tests__/support/fakeRhq"
import { markInterruptedAttempts, pushPeriod } from "../push"
import { STATE_KEYS } from "../store"
import { accepted, MEDUSA_STORE_ID, ORIGIN, paths, puts, pushWorld, rhqStub, sha256 } from "./support/world"

// Two hazards of a self-hosted store: a copy of the store
// pushing as the live one, and a process dying between
// RHQ accepting a month and the store recording it.

const live = { mode: "live", trigger: "scheduled" } as const
const manual = { mode: "live", trigger: "manual" } as const
const validate = { mode: "validate", trigger: "manual" } as const
const CONN = 7
const dryRunAnswer = { status: 202, body: { data: snapshotData({ result: "created", import_id: null }), dry_run: true } }

describe("the deployment guard (B9)", () => {
  it("refuses a live push from a changed origin, sending nothing, and holds live pushes off", async () => {
    const rhq = rhqStub({ writes: [dryRunAnswer] })
    const w = pushWorld({ rhq })
    w.deps.deployment = { origin: "https://staging.example.test" }
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "refused", problem: { code: "deployment_changed" } })
    expect(rhq.sent).toEqual([])
    expect(await w.store.readState(STATE_KEYS.deploymentHold)).toMatchObject({ recordedOrigin: ORIGIN, currentOrigin: "https://staging.example.test" })
    // Dry runs still work: they reach nothing RHQ keeps.
    expect(await pushPeriod(w.deps, "2026-08", validate)).toMatchObject({ kind: "accepted", mode: "dry_run" })
  })

  it("keeps refusing after the origin looks right again, until a person confirms the move", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    w.deps.deployment = { origin: "https://staging.example.test" }
    await pushPeriod(w.deps, "2026-08", live)
    w.deps.deployment = { origin: ORIGIN }
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "refused", problem: { code: "deployment_changed" } })
    expect(puts(rhq)).toEqual([])
    // What confirming in the admin will do: record the origin, lift the hold.
    await w.store.writeState(STATE_KEYS.deployment, { origin: ORIGIN, storeId: MEDUSA_STORE_ID })
    await w.store.writeState(STATE_KEYS.deploymentHold, null)
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted" })
  })

  it("refuses a copy that carries another store id", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq, storeId: "store_other" })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "refused", problem: { code: "deployment_changed" } })
    expect(rhq.sent).toEqual([])
  })

  it("refuses when nothing proves this is the deployment that switched sending on", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq })
    w.deps.deployment = { origin: null }
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "refused", problem: { code: "origin_unknown" } })
    w.deps.deployment = { origin: ORIGIN }
    await w.store.writeState(STATE_KEYS.deployment, null)
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "refused", problem: { code: "deployment_unrecorded" } })
    expect(rhq.sent).toEqual([])
  })
})

describe("a process that dies mid-push", () => {
  it("crash before send: nothing went, the attempt is closed as interrupted, and the next push sends", async () => {
    const rhq = rhqStub({ writes: [{ status: 404, body: PROBLEMS.snapshotNotFound() }, accepted("created")] })
    const w = pushWorld({ rhq })
    w.store.failNext("updateAttempt", new Error("process killed"))
    await expect(pushPeriod(w.deps, "2026-08", live)).rejects.toThrow("process killed")
    expect(puts(rhq)).toEqual([])
    expect(w.store.data.attempts[0]).toMatchObject({ state: "prepared", finished_at: null })

    w.setNow("2026-09-20T12:30:00.000Z")
    expect(await markInterruptedAttempts(w.store, new Date("2026-09-20T12:30:00.000Z"))).toBe(1)
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted", result: "created" })
    expect(puts(rhq)).toHaveLength(1)
  })

  it("crash after RHQ accepted but before the store recorded it: the next push proves it by the receipt and records the manifest", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    w.store.failNext("recordAcceptance", new Error("process killed"))
    await expect(pushPeriod(w.deps, "2026-08", live)).rejects.toThrow("process killed")
    const firstBody = puts(rhq)[0]!.body!
    expect(await w.store.findSnapshot({ connectionId: CONN, period: "2026-08", mode: "live" })).toBeNull()
    expect(w.store.data.attempts[0]).toMatchObject({ state: "sent" })

    // RHQ holds exactly those bytes, staged.
    rhq.state.periods = [{ period: "2026-08", status: "staged", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342 }]
    rhq.state.writes.push({ status: 200, body: { data: snapshotData({ payload_sha256: sha256(firstBody) }) } })
    w.setNow("2026-09-21T03:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "unchanged" })
    expect(paths(rhq).slice(-2)).toEqual(["GET /api/v1/connection", "GET /api/v1/sales-snapshots/2026-08"])
    expect(puts(rhq)).toHaveLength(1)
    expect(await w.store.findSnapshot({ connectionId: CONN, period: "2026-08", mode: "live" })).toMatchObject({
      status: "staged",
      pushed_order_ids: [w.orderId],
      pushed_at: expect.any(Date),
      payload_sha256: sha256(firstBody),
      generated_at: new Date(JSON.parse(firstBody).generated_at),
    })
    expect(w.store.data.attempts[0]).toMatchObject({ state: "accepted", result: "confirmed" })
    expect((await w.store.saleContexts(CONN, [w.orderId])).has(w.orderId)).toBe(true)
  })

  it("crash during the local commit leaves nothing half-written", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    w.store.failNext("recordAcceptance", new Error("connection lost mid-transaction"))
    await expect(pushPeriod(w.deps, "2026-08", live)).rejects.toThrow("connection lost")
    expect(w.store.data.snapshots).toEqual([])
    expect(w.store.data.saleContexts).toEqual([])
    expect(w.store.data.attempts[0]).toMatchObject({ state: "sent", result: null })
  })

  it("does not take RHQ's copy for the lost push when its receipt is of other bytes, and sends again", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    w.store.failNext("recordAcceptance", new Error("process killed"))
    await expect(pushPeriod(w.deps, "2026-08", live)).rejects.toThrow()
    rhq.state.writes.push({ status: 200, body: { data: snapshotData({ payload_sha256: "f".repeat(64) }) } }, accepted("replaced"))
    w.setNow("2026-09-21T03:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted", result: "replaced" })
    expect(w.store.data.attempts[0]).toMatchObject({ state: "sent" })
    expect(puts(rhq)).toHaveLength(2)
  })
})
