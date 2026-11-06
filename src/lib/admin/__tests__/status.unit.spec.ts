import { STATE_KEYS } from "../../push/store"
import { PLAN_KEY } from "../../push/tick"
import { snapshotData } from "../../rhq/__tests__/support/fakeRhq"
import { holdBackText } from "../../rhq/holdBack"
import { accepted, pushWorld, rhqStub } from "../../push/__tests__/support/world"
import { pushPeriod } from "../../push/push"
import { confirmDeployment, forgetConnection, recordDeploymentOnEnable, recordTestedConnection, statusView } from "../status"

// What the Royalties HQ status page shows: one line per month from the start
// month to the last that has ended, what RHQ holds for it, the last attempt,
// and whether this deployment may send.

const here = { origin: "https://shop.example.test", storeId: "store_01JC" }

describe("statusView", () => {
  it("lists each month from the start month, newest first, with what was sent and the last attempt", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" })] })
    const w = pushWorld({ rhq, settings: { start_month: "2026-07" } })
    await pushPeriod(w.deps, "2026-07", { mode: "live", trigger: "manual" })
    const view = await statusView(w.store, { now: new Date("2026-09-20T12:00:00Z"), ...here })
    expect(view.months.map((m) => m.period)).toEqual(["2026-08", "2026-07"])
    expect(view.months[1]).toMatchObject({
      period: "2026-07",
      status: "staged",
      import_url: "https://acme.royaltieshq.com/imports/342",
      last_attempt: { mode: "live", trigger: "manual", state: "accepted" },
    })
    expect(view.months[0]).toMatchObject({ period: "2026-08", status: null, last_attempt: null })
    expect(view).toMatchObject({ enabled: true, push_mode: "automatic", connected: true, deployment: { ok: true } })
  })

  it("keeps the last push in view after a later dry run, and shows the dry run beside it", async () => {
    const rhq = rhqStub({
      writes: [accepted("created", { period: "2026-07" }), { status: 202, body: { data: snapshotData({ result: "created", import_id: null, period: "2026-07" }), dry_run: true } }],
    })
    const w = pushWorld({ rhq, settings: { start_month: "2026-07" } })
    await pushPeriod(w.deps, "2026-07", { mode: "live", trigger: "manual" })
    w.setNow("2026-09-20T12:05:00.000Z")
    await pushPeriod(w.deps, "2026-07", { mode: "validate", trigger: "manual" })
    const july = (await statusView(w.store, { now: new Date("2026-09-20T12:10:00Z"), ...here })).months[1]!
    expect(july.last_attempt).toMatchObject({ mode: "live", state: "accepted" })
    expect(july.last_dry_run).toMatchObject({ mode: "dry_run", state: "accepted" })
  })

  it("drops a dry run that a later push has overtaken", async () => {
    const rhq = rhqStub({
      writes: [{ status: 202, body: { data: snapshotData({ result: "created", import_id: null, period: "2026-07" }), dry_run: true } }, accepted("created", { period: "2026-07" })],
    })
    const w = pushWorld({ rhq, settings: { start_month: "2026-07" } })
    await pushPeriod(w.deps, "2026-07", { mode: "validate", trigger: "manual" })
    w.setNow("2026-09-20T12:05:00.000Z")
    await pushPeriod(w.deps, "2026-07", { mode: "live", trigger: "manual" })
    const july = (await statusView(w.store, { now: new Date("2026-09-20T12:10:00Z"), ...here })).months[1]!
    expect(july.last_attempt).toMatchObject({ mode: "live" })
    expect(july.last_dry_run).toBeNull()
  })

  it("shows a dry run of a month never pushed", async () => {
    const rhq = rhqStub({ writes: [{ status: 202, body: { data: snapshotData({ result: "created", import_id: null, period: "2026-07" }), dry_run: true } }] })
    const w = pushWorld({ rhq, settings: { start_month: "2026-07" } })
    await pushPeriod(w.deps, "2026-07", { mode: "validate", trigger: "manual" })
    const july = (await statusView(w.store, { now: new Date("2026-09-20T12:10:00Z"), ...here })).months[1]!
    expect(july.last_attempt).toBeNull()
    expect(july.last_dry_run).toMatchObject({ mode: "dry_run" })
  })

  it("treats a dry run started with the push as no newer than it", async () => {
    const rhq = rhqStub({
      writes: [accepted("created", { period: "2026-07" }), { status: 202, body: { data: snapshotData({ result: "created", import_id: null, period: "2026-07" }), dry_run: true } }],
    })
    // The clock does not move: both attempts start at the same instant.
    const w = pushWorld({ rhq, settings: { start_month: "2026-07" } })
    await pushPeriod(w.deps, "2026-07", { mode: "live", trigger: "manual" })
    await pushPeriod(w.deps, "2026-07", { mode: "validate", trigger: "manual" })
    const july = (await statusView(w.store, { now: new Date("2026-09-20T12:10:00Z"), ...here })).months[1]!
    expect(july.last_dry_run).toBeNull()
  })

  it("says each hold-back note once, though two codes it does not know read the same", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07", hold_back_reasons: ["anomaly"] })] })
    const w = pushWorld({ rhq, settings: { start_month: "2026-07" } })
    await pushPeriod(w.deps, "2026-07", { mode: "live", trigger: "manual" })
    // Codes from a later RHQ: the contract stub cannot send them, the store can hold them.
    w.store.data.snapshots[0]!.hold_back_reasons = ["new_a", "new_b", "anomaly"]
    const july = (await statusView(w.store, { now: new Date("2026-09-20T12:00:00Z"), ...here })).months[1]!
    expect(july.hold_back_notes).toEqual([holdBackText("new_a"), holdBackText("anomaly")])
  })

  it("says in words why RHQ is holding a month for review", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07", hold_back_reasons: ["no_baseline", "anomaly"] })] })
    const w = pushWorld({ rhq, settings: { start_month: "2026-07" } })
    await pushPeriod(w.deps, "2026-07", { mode: "live", trigger: "manual" })
    const july = (await statusView(w.store, { now: new Date("2026-09-20T12:00:00Z"), ...here })).months[1]!
    expect(july.hold_back_reasons).toEqual(["no_baseline", "anomaly"])
    expect(july.hold_back_notes).toEqual([holdBackText("no_baseline"), holdBackText("anomaly")])
    expect(july.hold_back_notes[0]).toMatch(/no imported months to compare it with/)
  })

  it("says when a retry is planned", async () => {
    const w = pushWorld({ rhq: rhqStub() })
    await w.store.writeState(PLAN_KEY, { at: "2026-09-20T12:10:00.000Z", plan: { periods: ["2026-08"] } })
    expect((await statusView(w.store, { now: new Date("2026-09-20T12:00:00Z"), ...here })).planned).toEqual({ at: "2026-09-20T12:10:00.000Z", periods: ["2026-08"] })
  })

  it("flags a deployment that is not the one sending was enabled on", async () => {
    const w = pushWorld({ rhq: rhqStub() })
    const view = await statusView(w.store, { now: new Date("2026-09-20T12:00:00Z"), origin: "https://copy.example.test", storeId: here.storeId })
    expect(view.deployment).toMatchObject({ ok: false, code: "deployment_changed", currentOrigin: "https://copy.example.test" })
  })

  it("shows nothing for months before anything is set up", async () => {
    const w = pushWorld({ rhq: rhqStub(), settings: { start_month: null } })
    await w.store.writeState(STATE_KEYS.deployment, null)
    const view = await statusView(w.store, { now: new Date("2026-09-20T12:00:00Z"), ...here })
    expect(view.months).toEqual([])
    expect(view.connected).toBe(false)
  })
})

describe("recordDeploymentOnEnable", () => {
  it("records this deployment the first time sending is switched on, and never overwrites it", async () => {
    const w = pushWorld({ rhq: rhqStub() })
    await w.store.writeState(STATE_KEYS.deployment, null)
    await recordDeploymentOnEnable(w.store, { enabled: true }, here)
    expect(await w.store.readState(STATE_KEYS.deployment)).toEqual(here)
    // A copy that switches sending on must not adopt itself as the store.
    await recordDeploymentOnEnable(w.store, { enabled: true }, { origin: "https://copy.example.test", storeId: here.storeId })
    expect(await w.store.readState(STATE_KEYS.deployment)).toEqual(here)
  })

  it("records nothing while sending is off, or without an origin", async () => {
    const w = pushWorld({ rhq: rhqStub() })
    await w.store.writeState(STATE_KEYS.deployment, null)
    await recordDeploymentOnEnable(w.store, { enabled: false }, here)
    await recordDeploymentOnEnable(w.store, { enabled: true }, { origin: null, storeId: here.storeId })
    expect(await w.store.readState(STATE_KEYS.deployment)).toBeNull()
  })
})

describe("confirmDeployment", () => {
  it("makes this deployment the sender and lifts a deployment hold", async () => {
    const w = pushWorld({ rhq: rhqStub() })
    await w.store.writeState(STATE_KEYS.deploymentHold, { at: "2026-09-20T12:00:00Z" })
    expect(await confirmDeployment(w.store, { origin: "https://new.example.test", storeId: here.storeId })).toBe(true)
    expect(await w.store.readState(STATE_KEYS.deployment)).toEqual({ origin: "https://new.example.test", storeId: here.storeId })
    expect(await w.store.readState(STATE_KEYS.deploymentHold)).toBeNull()
  })

  it("refuses without an origin to record", async () => {
    const w = pushWorld({ rhq: rhqStub() })
    expect(await confirmDeployment(w.store, { origin: null, storeId: here.storeId })).toBe(false)
    expect(await w.store.readState(STATE_KEYS.deployment)).toEqual({ origin: "https://shop.example.test", storeId: here.storeId })
  })
})

describe("the connection after a token change", () => {
  // The page and the schedule read the months of the connection last
  // handshaken with. A new token may name another connection, whose months
  // are not the old one's: showing the old ones would call a month imported
  // that the new connection never got, and the schedule would skip it.
  const changedAt = new Date("2026-09-20T11:00:00Z")
  const pushedJuly = async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" })] })
    const w = pushWorld({ rhq, settings: { start_month: "2026-07" } })
    await pushPeriod(w.deps, "2026-07", { mode: "live", trigger: "manual" })
    return w
  }
  const view = async (w: Awaited<ReturnType<typeof pushedJuly>>) => statusView(w.store, { now: new Date("2026-09-20T12:00:00Z"), ...here })
  const july = async (w: Awaited<ReturnType<typeof pushedJuly>>) => (await view(w)).months.find((m) => m.period === "2026-07")!

  it("stops showing the old connection's months when the token changes, and says why", async () => {
    const w = await pushedJuly()
    await forgetConnection(w.store, changedAt)
    expect(await july(w)).toMatchObject({ status: null, last_attempt: null })
    expect(await view(w)).toMatchObject({ connected: false, connection_unconfirmed: true })
    expect(await w.store.readState(STATE_KEYS.connection)).toEqual({ unconfirmed_since: changedAt.toISOString() })
  })

  it("leaves no mark on a store never connected: there is no history to lose, so the export still works", async () => {
    const w = pushWorld({ rhq: rhqStub(), settings: { start_month: "2026-07" } })
    await forgetConnection(w.store, changedAt)
    expect(await w.store.readState(STATE_KEYS.connection)).toBeNull()
  })

  it("moves the mark to a second token change, since a push between the two used a token now replaced too", async () => {
    const w = await pushedJuly()
    await forgetConnection(w.store, changedAt)
    await forgetConnection(w.store, new Date("2026-09-20T11:30:00Z"))
    expect(await w.store.readState(STATE_KEYS.connection)).toEqual({ unconfirmed_since: "2026-09-20T11:30:00.000Z" })
  })

  it("is not unconfirmed before any token change", async () => {
    const w = await pushedJuly()
    expect(await view(w)).toMatchObject({ connected: true, connection_unconfirmed: false })
  })

  it("follows the connection a live Test connection names", async () => {
    const w = await pushedJuly()
    const id = (await w.store.readState<{ id: number }>(STATE_KEYS.connection))!.id
    await forgetConnection(w.store, changedAt)
    await recordTestedConnection(w.store, { ok: true, connection: { id, marketplace: "Acme Shop", tokenMode: "live" } })
    expect(await july(w)).toMatchObject({ status: "staged" })
    expect(await view(w)).toMatchObject({ connection_unconfirmed: false })
    expect(await w.store.readState(STATE_KEYS.connection)).toEqual({ id, marketplace: "Acme Shop" })
  })

  it("is confirmed by a test token too: it reads the same connection, and the mark must not outlive the change", async () => {
    const w = await pushedJuly()
    const id = (await w.store.readState<{ id: number }>(STATE_KEYS.connection))!.id
    await forgetConnection(w.store, changedAt)
    await recordTestedConnection(w.store, { ok: true, connection: { id, marketplace: "Acme Shop", tokenMode: "test" } })
    expect(await w.store.readState(STATE_KEYS.connection)).toEqual({ id, marketplace: "Acme Shop" })
  })

  it("records nothing from a failed test", async () => {
    const w = await pushedJuly()
    await forgetConnection(w.store, changedAt)
    await recordTestedConnection(w.store, { ok: false })
    expect(await w.store.readState(STATE_KEYS.connection)).toEqual({ unconfirmed_since: changedAt.toISOString() })
  })
})
