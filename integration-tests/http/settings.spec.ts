import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { adminHeaders, type Headers } from "./helpers/admin"

jest.setTimeout(120_000)

const TOKEN = "rhq_test_abcdefghijklmnopqrstuvwxyz0123456789WXYZ"
const BASE = "https://acme.example.test/api/v1"

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer }) => {
    let admin: Headers & { userId: string }
    const call = (method: "get" | "post" | "put" | "delete", p: string, body?: unknown) =>
      // axios takes a body before the config on post and put, never on get and delete.
      (api as any)[method](`/admin/royalties-hq${p}`, ...(method === "post" || method === "put" ? [body ?? {}] : []), { ...admin, validateStatus: () => true })

    // The runner empties the database after every test, the admin user too,
    // so each test sets up what it needs.
    beforeEach(async () => {
      admin = await adminHeaders(getContainer())
    })
    const saveBase = () => call("post", "/settings", { base_url: BASE, timezone: "Europe/London", sale_country: "GB", start_month: "2026-10" })

    it("shows the defaults and no token before anything is saved", async () => {
      const { status, data } = await call("get", "/settings")
      expect(status).toBe(200)
      expect(data).toMatchObject({ version: null, settings: { enabled: false, push_mode: "automatic" }, token: { set: false, source: "none" } })
    })

    it("refuses invalid settings with every error against its field", async () => {
      // Not the API root: invalid whatever the http policy (the harness allows
      // http for its stand-in RHQ; the https rule is unit-tested).
      const { status, data } = await call("post", "/settings", { base_url: "https://acme.example.test/", timezone: "Mars/Olympus" })
      expect(status).toBe(400)
      expect(data.errors.map((e: any) => `${e.field}:${e.code}`).sort()).toEqual(["base_url:invalid", "timezone:timezone_invalid"])
      // The admin SDK keeps only a refusal's message, so it must say what is wrong.
      for (const e of data.errors) expect(data.message).toContain(e.message)
      expect((await call("get", "/settings")).data.version).toBeNull()
    })

    it("saves a new version, recording who changed it", async () => {
      const { status, data } = await call("post", "/settings", { base_url: BASE, timezone: "Europe/London", sale_country: "GB" })
      expect(status).toBe(200)
      expect(data).toMatchObject({ version: 1, settings: { base_url: BASE, timezone: "Europe/London", enabled: false } })
      const row = await getContainer().resolve<any>("royaltiesHq").currentSettingsVersion()
      expect(row).toMatchObject({ version: 1, changed_by: admin.userId })
    })

    it("refuses to enable without a token", async () => {
      await saveBase()
      const { status, data } = await call("post", "/settings", { enabled: true })
      expect(status).toBe(400)
      expect(data.errors).toEqual([expect.objectContaining({ field: "token", code: "required" })])
    })

    it("takes a token write-only: sealed at rest, summarised, never echoed", async () => {
      await saveBase()
      const put = await call("put", "/token", { token: TOKEN })
      expect(put.status).toBe(200)
      expect(put.data.token).toEqual({ set: true, source: "stored", lastFour: "WXYZ", testMode: true })
      expect(JSON.stringify(put.data)).not.toContain(TOKEN)
      const [secret] = await getContainer().resolve<any>("royaltiesHq").listRhqSecrets({ key: "api_token" })
      expect(secret.sealed).not.toContain(TOKEN)
      expect(secret.base_url).toBe(BASE)
      const read = await call("get", "/settings")
      expect(read.data.token).toEqual({ set: true, source: "stored", lastFour: "WXYZ", testMode: true })
      expect(JSON.stringify(read.data)).not.toContain(TOKEN)
    })

    it("can be enabled once a token is stored", async () => {
      await saveBase()
      await call("put", "/token", { token: TOKEN })
      const { status, data } = await call("post", "/settings", { enabled: true })
      expect(status).toBe(200)
      expect(data.settings.enabled).toBe(true)
    })

    it("refuses a token that is not an RHQ token", async () => {
      const { status, data } = await call("put", "/token", { token: "hello" })
      expect(status).toBe(400)
      expect(data.code).toBe("token_invalid")
    })

    it("refuses a token before the base URL it is sealed for is saved", async () => {
      const { status, data } = await call("put", "/token", { token: TOKEN })
      expect(status).toBe(409)
      expect(data.code).toBe("base_url_required")
    })

    it("removes the stored token, and the plugin is disabled with it", async () => {
      await saveBase()
      await call("put", "/token", { token: TOKEN })
      await call("post", "/settings", { enabled: true })
      const del = await call("delete", "/token")
      expect(del.status).toBe(200)
      expect(del.data.token.set).toBe(false)
      const read = await call("get", "/settings")
      expect(read.data.settings.enabled).toBe(false)
    })
  },
})
