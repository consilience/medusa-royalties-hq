import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { adminHeaders, type Headers } from "./helpers/admin"
import { startRhq, type Handler } from "./helpers/rhq-server"
import { connectionBody, snapshotData } from "../../src/lib/rhq/__tests__/support/fakeRhq"
import royaltiesHqTick from "../../src/jobs/royalties-hq-tick"

jest.setTimeout(120_000)

const TOKEN = `rhq_live_${"p".repeat(40)}LMNO`
const ORIGIN = "https://store.example.test"

// The push path inside Medusa: the module store, the locking module, the
// sealed token, the store's id and this deployment's origin, wired from the
// container, against a stand-in RHQ on loopback. The store has no orders,
// so a month goes out empty; the row builder is proved elsewhere.
const answer: Handler = ({ method, path: p }) => {
  if (method === "GET" && p === "/api/v1/connection") return { status: 200, body: connectionBody() }
  const m = /^\/api\/v1\/sales-snapshots\/(\d{4}-\d{2})(\/validate)?$/.exec(p)
  if (m && m[2] && method === "POST") return { status: 202, body: { data: snapshotData({ period: m[1], result: "created", import_id: null }), dry_run: true } }
  if (m && method === "PUT") return { status: 202, body: { data: snapshotData({ period: m[1], result: "created" }) } }
  return { status: 404, body: {} }
}

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer }) => {
    let admin: Headers
    let rhq: Awaited<ReturnType<typeof startRhq>>
    const call = (method: "get" | "post" | "put", p: string, body?: unknown) =>
      (api as any)[method](`/admin/royalties-hq${p}`, ...(method === "post" || method === "put" ? [body ?? {}] : []), { ...admin, validateStatus: () => true })
    const storeId = async () => {
      const { data } = await getContainer().resolve(ContainerRegistrationKeys.QUERY).graph({ entity: "store", fields: ["id"] })
      return data[0].id as string
    }
    const setUp = async (extra: Record<string, unknown> = {}) => {
      await call("post", "/settings", { base_url: rhq.baseUrl, timezone: "Europe/London", sale_country: "GB", start_month: "2026-09" })
      await call("put", "/token", { token: TOKEN })
      const saved = await call("post", "/settings", { enabled: true, ...extra })
      expect(saved.status).toBe(200)
    }
    const sent = () => rhq.seen.filter((r) => r.method !== "GET")

    beforeAll(async () => {
      rhq = await startRhq(TOKEN, answer)
    })
    afterAll(() => rhq.close())
    beforeEach(async () => {
      admin = await adminHeaders(getContainer())
      rhq.seen.length = 0
    })

    it("records this deployment when sending is switched on, and shows it in the status", async () => {
      await setUp()
      const { status, data } = await call("get", "/status")
      expect(status).toBe(200)
      expect(data).toMatchObject({ enabled: true, deployment: { ok: true } })
      expect(data.months.map((m: any) => m.period).slice(-2)).toEqual(["2026-10", "2026-09"])
      expect(rhq.seen).toEqual([])
    })

    it("dry-runs a month: RHQ checks it and keeps nothing", async () => {
      await setUp()
      const { status, data } = await call("post", "/push", { period: "2026-10", dry_run: true })
      expect(status).toBe(200)
      expect(data).toMatchObject({ ok: true })
      const [validate] = sent()
      expect(validate).toMatchObject({ method: "POST", path: "/api/v1/sales-snapshots/2026-10/validate", authorised: true })
      const body = JSON.parse(validate!.body)
      expect(body).toMatchObject({ period: "2026-10", rows: [] })
      expect(JSON.stringify(body)).toContain(`medusa:${await storeId()}`)
      expect(validate!.body).not.toContain(TOKEN)
    })

    it("pushes a month live, and the status shows it staged in RHQ", async () => {
      await setUp({ push_mode: "manual" })
      expect((await call("post", "/push", { period: "2026-09" })).data).toMatchObject({ ok: true })
      expect(sent().map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/v1/sales-snapshots/2026-09"])
      const month = (await call("get", "/status")).data.months.find((m: any) => m.period === "2026-09")
      expect(month).toMatchObject({ status: "staged", last_attempt: { state: "accepted", trigger: "manual" } })
    })

    it("refuses a malformed month", async () => {
      await setUp()
      const { status, data } = await call("post", "/push", { period: "October" })
      expect(status).toBe(400)
      expect(data.code).toBe("period_invalid")
      expect(sent()).toEqual([])
    })

    it("sends nothing from the scheduled job in manual mode", async () => {
      await setUp({ push_mode: "manual" })
      await royaltiesHqTick(getContainer())
      expect(rhq.seen).toEqual([])
    })

    it("sends nothing from the scheduled job while sending is off", async () => {
      await call("post", "/settings", { base_url: rhq.baseUrl, timezone: "Europe/London", sale_country: "GB", start_month: "2026-09" })
      await call("put", "/token", { token: TOKEN })
      await royaltiesHqTick(getContainer())
      expect(rhq.seen).toEqual([])
    })

    it("pushes due months from the scheduled job in automatic mode", async () => {
      await setUp()
      await royaltiesHqTick(getContainer())
      // September's push day (15 October) has passed; October's (15 November) has not.
      expect(sent().map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/v1/sales-snapshots/2026-09"])
    })

    it("downloads a month as an RHQ import CSV without calling RHQ", async () => {
      await setUp()
      const res = await call("get", "/csv/2026-09")
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toMatch(/^text\/csv/)
      expect(res.headers["content-disposition"]).toBe('attachment; filename="royalties-hq-2026-09.csv"')
      expect(res.headers["cache-control"]).toBe("no-store")
      expect(String(res.data)).toContain("sales_month")
      expect(rhq.seen).toEqual([])
      expect((await call("get", "/csv/Sept")).status).toBe(400)
    })

    it("asks for the settings before a CSV can be built", async () => {
      const res = await call("get", "/csv/2026-09")
      expect(res.status).toBe(409)
      expect(res.data).toMatchObject({ code: "settings_missing", message: expect.stringMatching(/settings/i) })
    })

    it("confirms a move of the store to this deployment", async () => {
      await setUp()
      const { status, data } = await call("post", "/deployment")
      expect(status).toBe(200)
      expect(data.deployment).toEqual({ ok: true })
      void ORIGIN
    })
  },
})
