import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { adminHeaders, type Headers } from "./helpers/admin"
import { startRhq } from "./helpers/rhq-server"
import { connectionBody } from "../../src/lib/rhq/__tests__/support/fakeRhq"

jest.setTimeout(120_000)

const TOKEN = `rhq_live_${"c".repeat(40)}QRST`

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer }) => {
    let admin: Headers
    let rhq: Awaited<ReturnType<typeof startRhq>>
    const call = (method: "get" | "post" | "put", p: string, body?: unknown) =>
      // axios takes a body before the config on post and put, never on get and delete.
      (api as any)[method](`/admin/royalties-hq${p}`, ...(method === "post" || method === "put" ? [body ?? {}] : []), { ...admin, validateStatus: () => true })

    beforeAll(async () => {
      rhq = await startRhq(TOKEN, ({ method, path }) =>
        method === "GET" && path === "/api/v1/connection" ? { status: 200, body: connectionBody() } : { status: 404, body: {} },
      )
    })
    afterAll(() => rhq.close())
    beforeEach(async () => {
      admin = await adminHeaders(getContainer())
      rhq.seen.length = 0
    })

    it("connects with the stored token and shows only what is safe", async () => {
      await call("post", "/settings", { base_url: rhq.baseUrl, timezone: "Europe/London", sale_country: "GB" })
      await call("put", "/token", { token: TOKEN })
      const { status, data } = await call("post", "/connection")
      expect(status).toBe(200)
      expect(data).toEqual({
        ok: true,
        connection: { id: 7, name: "Acme Press Medusa", currency: "GBP", marketplace: "Acme Shop", tokenMode: "live", tokenExpiresAt: "2027-09-01T00:00:00Z" },
      })
      expect(rhq.seen).toEqual([expect.objectContaining({ method: "GET", path: "/api/v1/connection", authorised: true })])
      expect(JSON.stringify(data)).not.toContain(TOKEN)
    })

    it("records the connection it tested, marks it unconfirmed when the token is replaced, and keeps it when the token goes", async () => {
      const service = () => getContainer().resolve<any>("royaltiesHq")
      await call("post", "/settings", { base_url: rhq.baseUrl, timezone: "Europe/London", sale_country: "GB" })
      await call("put", "/token", { token: TOKEN })
      await call("post", "/connection")
      expect(await service().readState("connection")).toEqual({ id: 7, marketplace: "Acme Shop" })
      await call("put", "/token", { token: TOKEN })
      expect(await service().readState("connection")).toEqual({ unconfirmed_since: expect.any(String) })
      await call("post", "/connection")
      // Removing the token names no new connection: the last one's history
      // still holds, so the export can go on using it.
      await (api as any).delete("/admin/royalties-hq/token", { ...admin, validateStatus: () => true })
      expect(await service().readState("connection")).toEqual({ id: 7, marketplace: "Acme Shop" })
    })

    it("says so when nothing is set up", async () => {
      const { status, data } = await call("post", "/connection")
      expect(status).toBe(409)
      expect(data.code).toBe("not_configured")
      expect(rhq.seen).toEqual([])
    })

    it("asks for the token again after the base URL changes, and sends it nowhere", async () => {
      await call("post", "/settings", { base_url: rhq.baseUrl, timezone: "Europe/London", sale_country: "GB" })
      await call("put", "/token", { token: TOKEN })
      await call("post", "/settings", { base_url: "https://elsewhere.example.test/api/v1" })
      const { status, data } = await call("post", "/connection")
      expect(status).toBe(409)
      expect(data.code).toBe("token_rebind_required")
      expect(rhq.seen).toEqual([])
    })

    it("reports RHQ's refusal by its code", async () => {
      await call("post", "/settings", { base_url: rhq.baseUrl, timezone: "Europe/London", sale_country: "GB" })
      await call("put", "/token", { token: `rhq_live_${"d".repeat(40)}NOPE` })
      const { status, data } = await call("post", "/connection")
      expect(status).toBe(200)
      expect(data).toMatchObject({ ok: false, problem: { code: "unauthenticated", httpStatus: 401 } })
    })
  },
})
