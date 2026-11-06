import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { ROYALTIES_HQ_MODULE } from ".."
import { MODELS } from "../models"
import RoyaltiesHqModuleService from "../service"

jest.setTimeout(60 * 1000)

moduleIntegrationTestRunner<RoyaltiesHqModuleService>({
  moduleName: ROYALTIES_HQ_MODULE,
  moduleModels: Object.values(MODELS),
  resolve: "./src/modules/royaltiesHq",
  testSuite: ({ service }) => {
    describe("settings versions", () => {
      it("has no current settings until one is saved", async () => {
        expect(await service.currentSettingsVersion()).toBeNull()
      })

      it("appends a new version on every save and reads back the newest", async () => {
        const first = await service.appendSettingsVersion({ enabled: false, push_day: 15 }, "user_1")
        const second = await service.appendSettingsVersion({ enabled: true, push_day: 20 }, "user_2")
        expect(first.version).toBe(1)
        expect(second.version).toBe(2)
        const current = await service.currentSettingsVersion()
        expect(current).toMatchObject({ version: 2, data: { enabled: true, push_day: 20 }, changed_by: "user_2" })
        // Old versions stay: a refund is built with the settings in force on its date.
        expect((await service.listRhqSettings({})).map((r) => r.version).sort()).toEqual([1, 2])
      })
    })

    describe("variant config", () => {
      it("defaults a variant to not included", async () => {
        const row = await service.createRhqVariants({ variant_id: "variant_1" })
        expect(row).toMatchObject({ include: false, rhq_product_id: null, bundle_components: null })
      })

      it("keeps one row per variant", async () => {
        await service.createRhqVariants({ variant_id: "variant_2" })
        await expect(service.createRhqVariants({ variant_id: "variant_2" })).rejects.toThrow()
      })
    })

    describe("snapshots", () => {
      const base = {
        period: "2026-10",
        mode: "live" as const,
        status: "staged" as const,
        refund_cutoff_at: new Date("2026-11-15T10:00:00Z"),
        content_hash: "a".repeat(64),
        generated_at: new Date("2026-11-15T10:00:00Z"),
        row_count: 3,
        totals: { GBP: "12.00" },
      }

      it("keeps one snapshot per connection, period and mode, and history apart per connection", async () => {
        await service.createRhqSnapshots({ ...base, connection_id: 1 })
        await service.createRhqSnapshots({ ...base, connection_id: 2 })
        await expect(service.createRhqSnapshots({ ...base, connection_id: 1 })).rejects.toThrow()
      })

      it("stores manifests as lists that replace, not merge, on update", async () => {
        const row = await service.createRhqSnapshots({ ...base, connection_id: 3, pushed_refund_ids: ["r1", "r2"] })
        await service.updateRhqSnapshots({ id: row.id, pushed_refund_ids: ["r3"] })
        const [read] = await service.listRhqSnapshots({ id: row.id })
        expect(read.pushed_refund_ids).toEqual(["r3"])
      })
    })

    describe("sale contexts", () => {
      it("keeps one context per order on each connection, so a new connection starts without them", async () => {
        const ctx = { included: {}, bundleSplit: "even" }
        await service.createRhqSaleContexts({ connection_id: 1, order_id: "order_1", context: ctx })
        await service.createRhqSaleContexts({ connection_id: 2, order_id: "order_1", context: ctx })
        await expect(service.createRhqSaleContexts({ connection_id: 1, order_id: "order_1", context: ctx })).rejects.toThrow()
        expect(await service.listRhqSaleContexts({ connection_id: 2 })).toHaveLength(1)
      })
    })

    describe("state", () => {
      it("reads, writes and overwrites a key", async () => {
        expect(await service.readState("deployment")).toBeNull()
        await service.writeState("deployment", { origin: "https://a.example" })
        await service.writeState("deployment", { origin: "https://b.example" })
        expect(await service.readState("deployment")).toEqual({ origin: "https://b.example" })
      })

      it("replaces a value whole, never merging it", async () => {
        await service.writeState("last_notice", { "2026-09": "a", "2026-10": "b" })
        await service.writeState("last_notice", { "2026-10": "c" })
        expect(await service.readState("last_notice")).toEqual({ "2026-10": "c" })
      })

      it("lets two writes of one key race: both succeed, one wins, and the key is never missing", async () => {
        await service.writeState("push_plan", { n: 0 })
        const results = await Promise.allSettled([
          service.writeState("push_plan", { n: 1 }),
          service.writeState("push_plan", { n: 2 }),
          service.readState("push_plan"),
        ])
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
        expect((results[2] as PromiseFulfilledResult<unknown>).value).not.toBeNull()
        expect([1, 2]).toContain(((await service.readState("push_plan")) as { n: number }).n)
      })

      it("stores null and scalars", async () => {
        await service.writeState("recheck_at", "2026-09-21T12:00:00.000Z")
        expect(await service.readState("recheck_at")).toBe("2026-09-21T12:00:00.000Z")
        await service.writeState("recheck_at", null)
        expect(await service.readState("recheck_at")).toBeNull()
      })
    })
  },
})
