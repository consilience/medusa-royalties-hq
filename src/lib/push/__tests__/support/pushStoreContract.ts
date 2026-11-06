import type { SaleContext } from "../../../../core/types"
import { DEFAULT_SETTINGS, type StoredSettings } from "../../../settings/settings"
import {
  STATE_KEYS,
  type AcceptanceManifest,
  type AcceptanceWrite,
  type AttemptCreate,
  type FrozenReason,
  type PushStore,
  type SnapshotData,
  type SnapshotKey,
} from "../../store"

// One set of expectations for every PushStore. The in-memory store is the
// reference the push tests run against; the module-backed store must behave
// the same, so both run this suite and neither may drift from the other.

export interface PushStoreHarness {
  store: PushStore
  seedSettings(s: StoredSettings): Promise<void>
  /** Makes the next call of `method` fail after it has made some of its writes. */
  failNext(method: "recordAcceptance" | "syncSnapshot"): Promise<void>
  /** How a recorded sale context was frozen, which the interface only reports as a flag. */
  frozenAs(connectionId: number, orderId: string): Promise<{ at: Date | null; reason: FrozenReason | null } | null>
}

const at = (iso: string) => new Date(iso)

const KEY: SnapshotKey = { connectionId: 7, period: "2026-10", mode: "live" }

const snapshotData = (over: Partial<SnapshotData> = {}): SnapshotData => ({
  status: "staged",
  refund_cutoff_at: at("2026-11-15T10:00:00Z"),
  content_hash: "a".repeat(64),
  generated_at: at("2026-11-15T10:00:01Z"),
  row_count: 3,
  totals: { GBP: "12.00" },
  ...over,
})

const attemptData = (over: Partial<AttemptCreate> = {}): AttemptCreate => ({
  connection_id: 7,
  period: "2026-10",
  mode: "live",
  trigger: "manual",
  state: "prepared",
  started_at: at("2026-11-15T10:00:00Z"),
  ...over,
})

const ctx = (included: Record<string, boolean>, prices: Record<string, string | null> = {}): SaleContext => ({
  included,
  bundleSplit: "price_ratio",
  bundleFallback: "even",
  regularUnitPrices: prices,
} as SaleContext)

const manifest = (over: Partial<AcceptanceManifest> = {}): AcceptanceManifest => ({
  refund_cutoff_at: "2026-11-15T10:00:00.000Z",
  generated_at: "2026-11-15T10:00:01.000Z",
  content_hash: "a".repeat(64),
  row_count: 3,
  totals: { GBP: "12.00" },
  pushed_refund_ids: [],
  reported_money_only_refund_ids: [],
  applied_money_only_refund_ids: [],
  pushed_order_ids: ["order_1"],
  refunded_orders_sold_elsewhere: [],
  sale_contexts: { order_1: ctx({ v1: true }) },
  ...over,
})

export function describePushStoreContract(makeHarness: () => PushStoreHarness | Promise<PushStoreHarness>): void {
  let h: PushStoreHarness
  let store: PushStore
  beforeEach(async () => {
    h = await makeHarness()
    store = h.store
  })

  const acceptance = async (over: Partial<AcceptanceWrite> = {}): Promise<AcceptanceWrite> => {
    const attempt = await store.createAttempt(attemptData())
    return {
      connectionId: 7,
      period: "2026-10",
      attemptId: attempt.id,
      attempt: { state: "accepted", finished_at: at("2026-11-15T10:00:05Z"), http_status: 200, import_id: 41, result: "created" },
      snapshot: snapshotData({
        status: "staged",
        import_id: 41,
        pushed_at: at("2026-11-15T10:00:05Z"),
        pushed_order_ids: ["order_1"],
        pushed_refund_ids: [],
      }),
      saleContexts: { captured: { order_1: ctx({ v1: true }) }, pushedOrderIds: ["order_1"] },
      freeze: { orderIds: [], reason: "refund_reported", at: at("2026-11-15T10:00:05Z") },
      ...over,
    }
  }

  describe("settings", () => {
    it("has none before the first save, then the latest saved", async () => {
      expect(await store.currentSettings()).toBeNull()
      await h.seedSettings({ ...DEFAULT_SETTINGS, push_day: 10 })
      await h.seedSettings({ ...DEFAULT_SETTINGS, push_day: 20, notify_emails: ["a@example.com"] })
      expect(await store.currentSettings()).toEqual({ ...DEFAULT_SETTINGS, push_day: 20, notify_emails: ["a@example.com"] })
    })
  })

  describe("state", () => {
    it("reads null for a missing key, then what was written", async () => {
      expect(await store.readState("deployment")).toBeNull()
      await store.writeState("deployment", { origin: "https://a.example", storeId: "s1" })
      expect(await store.readState("deployment")).toEqual({ origin: "https://a.example", storeId: "s1" })
    })

    it("replaces a value whole rather than merging it", async () => {
      await store.writeState("deployment", { origin: "https://a.example", storeId: "s1" })
      await store.writeState("deployment", { origin: "https://b.example" })
      expect(await store.readState("deployment")).toEqual({ origin: "https://b.example" })
    })
  })

  describe("snapshots", () => {
    it("creates a row on first upsert, with nothing pushed yet", async () => {
      const row = await store.upsertSnapshot(KEY, snapshotData({ hold_back_reasons: ["missing_isbn"] }), { countAttempt: false })
      expect(row).toMatchObject({
        id: expect.any(String),
        connection_id: 7,
        period: "2026-10",
        mode: "live",
        status: "staged",
        row_count: 3,
        totals: { GBP: "12.00" },
        hold_back_reasons: ["missing_isbn"],
        attempts: 0,
        import_id: null,
        pushed_at: null,
        pushed_order_ids: null,
        pushed_refund_ids: null,
        last_http_status: null,
      })
      expect(row.refund_cutoff_at).toEqual(at("2026-11-15T10:00:00Z"))
      expect(row.generated_at).toEqual(at("2026-11-15T10:00:01Z"))
      expect(await store.findSnapshot(KEY)).toMatchObject({ id: row.id, totals: { GBP: "12.00" } })
    })

    it("counts the first attempt when asked", async () => {
      const row = await store.upsertSnapshot(KEY, snapshotData(), { countAttempt: true })
      expect(row.attempts).toBe(1)
    })

    it("updates the same row on a second upsert, counting an attempt only when asked", async () => {
      const first = await store.upsertSnapshot(KEY, snapshotData(), { countAttempt: true })
      const second = await store.upsertSnapshot(KEY, snapshotData({ row_count: 5 }), { countAttempt: false })
      const third = await store.upsertSnapshot(KEY, snapshotData({ row_count: 6 }), { countAttempt: true })
      expect(second).toMatchObject({ id: first.id, row_count: 5, attempts: 1 })
      expect(third).toMatchObject({ id: first.id, row_count: 6, attempts: 2 })
      expect(await store.listSnapshots(7)).toHaveLength(1)
    })

    it("replaces totals and hold-back reasons whole on upsert", async () => {
      await store.upsertSnapshot(KEY, snapshotData({ totals: { GBP: "2.00" }, hold_back_reasons: ["a", "b"] }), { countAttempt: false })
      const row = await store.upsertSnapshot(KEY, snapshotData({ totals: { USD: "1.00" }, hold_back_reasons: ["c"] }), { countAttempt: false })
      expect(row.totals).toEqual({ USD: "1.00" })
      expect(row.hold_back_reasons).toEqual(["c"])
      const read = await store.findSnapshot(KEY)
      expect(read?.totals).toEqual({ USD: "1.00" })
      expect(read?.hold_back_reasons).toEqual(["c"])
    })

    it("keeps months apart by connection, period and mode, and lists one connection's", async () => {
      await store.upsertSnapshot(KEY, snapshotData(), { countAttempt: false })
      await store.upsertSnapshot({ ...KEY, mode: "test" }, snapshotData(), { countAttempt: false })
      await store.upsertSnapshot({ ...KEY, period: "2026-09" }, snapshotData(), { countAttempt: false })
      await store.upsertSnapshot({ ...KEY, connectionId: 8 }, snapshotData(), { countAttempt: false })
      const rows = await store.listSnapshots(7)
      expect(rows.map((r) => `${r.period}/${r.mode}`).sort()).toEqual(["2026-09/live", "2026-10/live", "2026-10/test"])
      expect(await store.findSnapshot({ ...KEY, period: "2026-08" })).toBeNull()
    })

    it("returns dates as Dates and manifests as arrays", async () => {
      const row = await store.upsertSnapshot(KEY, snapshotData({ pushed_at: at("2026-11-15T10:00:05Z"), pushed_order_ids: ["o1", "o2"] }), { countAttempt: false })
      const [read] = await store.listSnapshots(7)
      for (const r of [row, read]) {
        expect(r.refund_cutoff_at).toBeInstanceOf(Date)
        expect(r.generated_at).toBeInstanceOf(Date)
        expect(r.pushed_at).toBeInstanceOf(Date)
        expect(r.pushed_order_ids).toEqual(["o1", "o2"])
      }
    })

    it("patches by id, replacing JSON fields and manifests whole, and counts an attempt when asked", async () => {
      const row = await store.upsertSnapshot(
        KEY,
        snapshotData({ totals: { GBP: "2.00" }, hold_back_reasons: ["a"], pushed_refund_ids: ["r1", "r2"] }),
        { countAttempt: false },
      )
      await store.updateSnapshot(row.id, { totals: { USD: "1.00" }, hold_back_reasons: null, pushed_refund_ids: ["r3"], last_http_status: 422 })
      await store.updateSnapshot(row.id, { error_code: "invalid" }, { countAttempt: true })
      const read = await store.findSnapshot(KEY)
      expect(read?.totals).toEqual({ USD: "1.00" })
      expect(read).toMatchObject({
        hold_back_reasons: null,
        pushed_refund_ids: ["r3"],
        last_http_status: 422,
        error_code: "invalid",
        attempts: 1,
      })
    })

    it("refuses to patch a snapshot that does not exist", async () => {
      await expect(store.updateSnapshot("rhqsnap_missing", { row_count: 1 })).rejects.toThrow()
    })
  })

  describe("updateSnapshotIf", () => {
    it("writes while the row still names the import and status", async () => {
      const row = await store.upsertSnapshot(KEY, snapshotData({ status: "staged", import_id: 41 }), { countAttempt: false })
      expect(await store.updateSnapshotIf(row.id, { import_id: 41, status: "staged" }, { status: "imported", totals: { USD: "1.00" } })).toBe(true)
      const read = await store.findSnapshot(KEY)
      expect(read?.status).toBe("imported")
      expect(read?.totals).toEqual({ USD: "1.00" })
    })

    it("does not write once another import or status has replaced it", async () => {
      const row = await store.upsertSnapshot(KEY, snapshotData({ status: "staged", import_id: 42 }), { countAttempt: false })
      expect(await store.updateSnapshotIf(row.id, { import_id: 41, status: "staged" }, { status: "imported" })).toBe(false)
      expect(await store.updateSnapshotIf(row.id, { import_id: 42, status: "imported" }, { status: "rejected" })).toBe(false)
      expect(await store.findSnapshot(KEY)).toMatchObject({ status: "staged", import_id: 42 })
    })

    it("matches a row with no import against a null import id", async () => {
      const row = await store.upsertSnapshot(KEY, snapshotData({ status: "failed" }), { countAttempt: false })
      expect(await store.updateSnapshotIf(row.id, { import_id: 41, status: "failed" }, { error_code: "x" })).toBe(false)
      expect(await store.updateSnapshotIf(row.id, { import_id: null, status: "failed" }, { error_code: "y" })).toBe(true)
      expect((await store.findSnapshot(KEY))?.error_code).toBe("y")
    })

    it("returns false for a snapshot that does not exist", async () => {
      expect(await store.updateSnapshotIf("rhqsnap_missing", { import_id: null, status: "staged" }, { error_code: "x" })).toBe(false)
    })
  })

  describe("attempts", () => {
    it("creates an attempt with nothing recorded yet", async () => {
      const a = await store.createAttempt(attemptData())
      expect(a).toMatchObject({
        id: expect.any(String),
        connection_id: 7,
        period: "2026-10",
        mode: "live",
        trigger: "manual",
        state: "prepared",
        finished_at: null,
        http_status: null,
        row_errors: null,
        manifest: null,
        warnings: null,
        retry_at: null,
        retry_count: 0,
      })
      expect(a.started_at).toEqual(at("2026-11-15T10:00:00Z"))
    })

    it("replaces row errors, manifest and warnings whole on update", async () => {
      const a = await store.createAttempt(
        attemptData({
          row_errors: { r1: ["bad isbn"] },
          manifest: manifest({ totals: { GBP: "2.00" }, sale_contexts: { order_1: ctx({ v1: true }, { v1: "100" }) } }),
          warnings: [{ code: "w1" }, { code: "w2" }],
        }),
      )
      const next = manifest({ totals: { USD: "1.00" }, sale_contexts: { order_2: ctx({ v2: false }) } })
      await store.updateAttempt(a.id, { row_errors: { r2: ["bad price"] }, manifest: next, warnings: [{ code: "w3" }], state: "sent" })
      const read = await store.latestAttempt({ connectionId: 7, period: "2026-10", mode: "live" })
      expect(read?.row_errors).toEqual({ r2: ["bad price"] })
      expect(read?.manifest).toEqual(next)
      expect(read?.warnings).toEqual([{ code: "w3" }])
      expect(read?.state).toBe("sent")
    })

    it("replaces a nested manifest value whole, not just its top level", async () => {
      const a = await store.createAttempt(attemptData({ manifest: manifest({ sale_contexts: { order_1: ctx({ v1: true, v2: true }) } }) }))
      const next = manifest({ sale_contexts: { order_1: ctx({ v3: false }) } })
      await store.updateAttempt(a.id, { manifest: next })
      const read = await store.latestAttempt({ connectionId: 7, period: "2026-10", mode: "live" })
      expect(read?.manifest?.sale_contexts.order_1.included).toEqual({ v3: false })
    })

    it("finds the latest by started_at, not by creation", async () => {
      const later = await store.createAttempt(attemptData({ started_at: at("2026-11-15T12:00:00Z") }))
      await store.createAttempt(attemptData({ started_at: at("2026-11-15T11:00:00Z") }))
      expect((await store.latestAttempt({ connectionId: 7, period: "2026-10", mode: "live" }))?.id).toBe(later.id)
    })

    it("filters by connection, period, mode and state", async () => {
      const accepted = await store.createAttempt(attemptData({ state: "accepted", started_at: at("2026-11-15T09:00:00Z") }))
      await store.createAttempt(attemptData({ state: "failed", started_at: at("2026-11-15T10:00:00Z") }))
      await store.createAttempt(attemptData({ connection_id: 8, state: "accepted", started_at: at("2026-11-15T11:00:00Z") }))
      await store.createAttempt(attemptData({ period: "2026-09", state: "accepted", started_at: at("2026-11-15T11:00:00Z") }))
      await store.createAttempt(attemptData({ mode: "test", state: "accepted", started_at: at("2026-11-15T11:00:00Z") }))
      const filter = { connectionId: 7, period: "2026-10", mode: "live" as const }
      expect((await store.latestAttempt({ ...filter, states: ["accepted", "sent"] }))?.id).toBe(accepted.id)
      expect((await store.latestAttempt(filter))?.state).toBe("failed")
      expect(await store.latestAttempt({ ...filter, states: ["unknown"] })).toBeNull()
      expect(await store.latestAttempt({ ...filter, period: "2026-08" })).toBeNull()
    })

    it("closes prepared and sent attempts started before the cut-off as interrupted", async () => {
      const cutoff = at("2026-11-15T10:00:00Z")
      const now = at("2026-11-15T10:30:00Z")
      const prepared = await store.createAttempt(attemptData({ state: "prepared", started_at: at("2026-11-15T09:00:00Z") }))
      const sent = await store.createAttempt(attemptData({ period: "2026-09", state: "sent", started_at: at("2026-11-15T09:30:00Z") }))
      const fresh = await store.createAttempt(attemptData({ period: "2026-08", state: "prepared", started_at: at("2026-11-15T10:10:00Z") }))
      const done = await store.createAttempt(attemptData({ period: "2026-07", state: "accepted", started_at: at("2026-11-15T09:00:00Z") }))
      expect(await store.markInterrupted(cutoff, now)).toBe(2)
      const read = async (period: string) => store.latestAttempt({ connectionId: 7, period, mode: "live" })
      expect(await read("2026-10")).toMatchObject({ id: prepared.id, state: "interrupted", finished_at: now })
      expect(await read("2026-09")).toMatchObject({ id: sent.id, state: "interrupted", finished_at: now })
      expect(await read("2026-08")).toMatchObject({ id: fresh.id, state: "prepared", finished_at: null })
      expect(await read("2026-07")).toMatchObject({ id: done.id, state: "accepted", finished_at: null })
      expect(await store.markInterrupted(cutoff, now)).toBe(0)
    })
  })

  describe("sale contexts", () => {
    it("reads nothing before any acceptance, and nothing for no orders", async () => {
      expect((await store.saleContexts(7, ["order_1"])).size).toBe(0)
      expect((await store.saleContexts(7, [])).size).toBe(0)
    })

    it("reads only the asked orders on the asked connection", async () => {
      await store.recordAcceptance(
        await acceptance({
          saleContexts: { captured: { order_1: ctx({ v1: true }), order_2: ctx({ v2: true }) }, pushedOrderIds: ["order_1", "order_2"] },
        }),
      )
      const mine = await store.saleContexts(7, ["order_1", "order_3"])
      expect([...mine.keys()]).toEqual(["order_1"])
      expect(mine.get("order_1")).toEqual({ context: ctx({ v1: true }), frozen: false })
      expect((await store.saleContexts(8, ["order_1", "order_2"])).size).toBe(0)
    })
  })

  describe("recordAcceptance", () => {
    it("records the attempt's outcome and creates the live snapshot, counting the attempt", async () => {
      const w = await acceptance()
      await store.recordAcceptance(w)
      expect(await store.latestAttempt({ connectionId: 7, period: "2026-10", mode: "live" })).toMatchObject({
        id: w.attemptId,
        state: "accepted",
        http_status: 200,
        import_id: 41,
        result: "created",
      })
      expect(await store.findSnapshot(KEY)).toMatchObject({ status: "staged", import_id: 41, attempts: 1, pushed_order_ids: ["order_1"] })
    })

    it("replaces the snapshot's manifests and totals whole", async () => {
      await store.upsertSnapshot(
        KEY,
        snapshotData({ totals: { GBP: "2.00", EUR: "3.00" }, pushed_order_ids: ["order_0", "order_1"], pushed_refund_ids: ["r1"] }),
        { countAttempt: true },
      )
      await store.recordAcceptance(
        await acceptance({ snapshot: snapshotData({ totals: { USD: "1.00" }, pushed_order_ids: ["order_1"], pushed_refund_ids: [] }) }),
      )
      const read = await store.findSnapshot(KEY)
      expect(read?.totals).toEqual({ USD: "1.00" })
      expect(read).toMatchObject({ pushed_order_ids: ["order_1"], pushed_refund_ids: [], attempts: 2 })
    })

    it("records sale contexts only for the orders the body carried", async () => {
      await store.recordAcceptance(
        await acceptance({
          saleContexts: { captured: { order_1: ctx({ v1: true }), order_9: ctx({ v9: true }) }, pushedOrderIds: ["order_1"] },
        }),
      )
      const got = await store.saleContexts(7, ["order_1", "order_9"])
      expect([...got.keys()]).toEqual(["order_1"])
    })

    it("replaces an unfrozen context whole on a later acceptance", async () => {
      await store.recordAcceptance(
        await acceptance({ saleContexts: { captured: { order_1: ctx({ v1: true, v2: true }, { v1: "100" }) }, pushedOrderIds: ["order_1"] } }),
      )
      await store.recordAcceptance(
        await acceptance({ saleContexts: { captured: { order_1: ctx({ v3: false }) }, pushedOrderIds: ["order_1"] } }),
      )
      expect((await store.saleContexts(7, ["order_1"])).get("order_1")).toEqual({ context: ctx({ v3: false }), frozen: false })
    })

    it("never overwrites a frozen context", async () => {
      await store.recordAcceptance(await acceptance({ saleContexts: { captured: { order_1: ctx({ v1: true }) }, pushedOrderIds: ["order_1"] } }))
      await store.recordAcceptance(
        await acceptance({ saleContexts: { captured: {}, pushedOrderIds: [] }, freeze: { orderIds: ["order_1"], reason: "refund_reported", at: at("2026-12-01T00:00:00Z") } }),
      )
      await store.recordAcceptance(await acceptance({ saleContexts: { captured: { order_1: ctx({ v1: false }) }, pushedOrderIds: ["order_1"] } }))
      expect((await store.saleContexts(7, ["order_1"])).get("order_1")).toEqual({ context: ctx({ v1: true }), frozen: true })
    })

    it("freezes the listed orders' contexts on this connection only, keeping the first reason and time", async () => {
      await store.recordAcceptance(await acceptance({ saleContexts: { captured: { order_1: ctx({ v1: true }) }, pushedOrderIds: ["order_1"] } }))
      await store.recordAcceptance({
        ...(await acceptance({ saleContexts: { captured: { order_1: ctx({ v1: true }) }, pushedOrderIds: ["order_1"] } })),
        connectionId: 8,
      })
      const first = at("2026-12-01T00:00:00Z")
      await store.recordAcceptance(
        await acceptance({ saleContexts: { captured: {}, pushedOrderIds: [] }, freeze: { orderIds: ["order_1", "order_none"], reason: "refund_reported", at: first } }),
      )
      expect((await store.saleContexts(7, ["order_1", "order_none"])).get("order_1")?.frozen).toBe(true)
      expect((await store.saleContexts(7, ["order_none"])).size).toBe(0)
      expect((await store.saleContexts(8, ["order_1"])).get("order_1")?.frozen).toBe(false)
      await store.recordAcceptance(
        await acceptance({ saleContexts: { captured: {}, pushedOrderIds: [] }, freeze: { orderIds: ["order_1"], reason: "period_imported", at: at("2027-01-01T00:00:00Z") } }),
      )
      expect(await h.frozenAs(7, "order_1")).toEqual({ at: first, reason: "refund_reported" })
    })

    it("leaves nothing behind when a later write in the group fails", async () => {
      await store.recordAcceptance(await acceptance({ saleContexts: { captured: { order_0: ctx({ v0: true }) }, pushedOrderIds: ["order_0"] } }))
      const before = await store.findSnapshot(KEY)
      const w = await acceptance({
        snapshot: snapshotData({ totals: { USD: "9.00" }, import_id: 99, pushed_order_ids: ["order_0", "order_1"] }),
        saleContexts: { captured: { order_0: ctx({ v0: false }), order_1: ctx({ v1: true }) }, pushedOrderIds: ["order_0", "order_1"] },
        freeze: { orderIds: ["order_0"], reason: "refund_reported", at: at("2026-12-01T00:00:00Z") },
      })
      await h.failNext("recordAcceptance")
      await expect(store.recordAcceptance(w)).rejects.toThrow()
      expect(await store.latestAttempt({ connectionId: 7, period: "2026-10", mode: "live" })).toMatchObject({ id: w.attemptId, state: "prepared", import_id: null })
      expect(await store.findSnapshot(KEY)).toEqual(before)
      const contexts = await store.saleContexts(7, ["order_0", "order_1"])
      expect([...contexts.keys()]).toEqual(["order_0"])
      expect(contexts.get("order_0")).toEqual({ context: ctx({ v0: true }), frozen: false })
    })
  })

  describe("syncSnapshot", () => {
    it("patches the snapshot, replacing JSON fields whole, without freezing anything", async () => {
      await store.recordAcceptance(await acceptance())
      const row = (await store.findSnapshot(KEY))!
      await store.syncSnapshot(row.id, { status: "imported", totals: { USD: "1.00" }, rhq_checked_at: at("2026-11-20T00:00:00Z") }, null)
      const read = await store.findSnapshot(KEY)
      expect(read?.totals).toEqual({ USD: "1.00" })
      expect(read).toMatchObject({ status: "imported", rhq_checked_at: at("2026-11-20T00:00:00Z") })
      expect((await store.saleContexts(7, ["order_1"])).get("order_1")?.frozen).toBe(false)
    })

    it("freezes the month's contexts with the patch", async () => {
      await store.recordAcceptance(await acceptance())
      const row = (await store.findSnapshot(KEY))!
      const when = at("2026-11-20T00:00:00Z")
      await store.syncSnapshot(row.id, { status: "imported" }, { connectionId: 7, orderIds: ["order_1"], reason: "period_imported", at: when })
      expect((await store.findSnapshot(KEY))?.status).toBe("imported")
      expect((await store.saleContexts(7, ["order_1"])).get("order_1")?.frozen).toBe(true)
      expect(await h.frozenAs(7, "order_1")).toEqual({ at: when, reason: "period_imported" })
    })

    it("leaves the snapshot unchanged when the freeze fails", async () => {
      await store.recordAcceptance(await acceptance())
      const before = (await store.findSnapshot(KEY))!
      await h.failNext("syncSnapshot")
      await expect(
        store.syncSnapshot(before.id, { status: "imported", totals: { USD: "1.00" } }, { connectionId: 7, orderIds: ["order_1"], reason: "period_imported", at: at("2026-11-20T00:00:00Z") }),
      ).rejects.toThrow()
      expect(await store.findSnapshot(KEY)).toEqual(before)
      expect((await store.saleContexts(7, ["order_1"])).get("order_1")?.frozen).toBe(false)
    })
  })

  describe("claimManualCheck", () => {
    const interval = 60_000
    const t0 = at("2026-11-15T10:00:00Z")
    const plus = (ms: number) => new Date(t0.getTime() + ms)

    it("claims the first check and records when", async () => {
      expect(await store.claimManualCheck(t0, interval)).toBe(true)
      expect(await store.readState(STATE_KEYS.manualCheckAt)).toBe(t0.toISOString())
    })

    it("refuses inside the interval and claims again once it has passed", async () => {
      expect(await store.claimManualCheck(t0, interval)).toBe(true)
      expect(await store.claimManualCheck(plus(interval - 1), interval)).toBe(false)
      expect(await store.readState(STATE_KEYS.manualCheckAt)).toBe(t0.toISOString())
      expect(await store.claimManualCheck(plus(interval), interval)).toBe(true)
      expect(await store.readState(STATE_KEYS.manualCheckAt)).toBe(plus(interval).toISOString())
    })

    it("lets only one of two simultaneous checks through", async () => {
      // Settled rather than awaited together: losing the race must be a plain
      // false, not an error.
      const results = await Promise.allSettled([store.claimManualCheck(t0, interval), store.claimManualCheck(t0, interval)])
      const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value : "threw"))
      expect(outcomes.sort()).toEqual([false, true])
    })
  })
}
