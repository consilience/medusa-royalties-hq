import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { adminHeaders, type Headers } from "./helpers/admin"

jest.setTimeout(120_000)

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer }) => {
    let admin: Headers
    beforeAll(async () => {
      admin = await adminHeaders(getContainer())
    })

    it("boots with the plugin's module loaded", async () => {
      expect((await api.get("/health")).status).toBe(200)
      await expect(getContainer().resolve<any>("royaltiesHq").currentSettingsVersion()).resolves.toBeNull()
    })

    it("serves its admin routes only to a signed-in admin", async () => {
      const anon = await api.get("/admin/royalties-hq/settings", { validateStatus: () => true })
      expect(anon.status).toBe(401)
      const signedIn = await api.get("/admin/royalties-hq/settings", admin)
      expect(signedIn.status).toBe(200)
    })
  },
})
