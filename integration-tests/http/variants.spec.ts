import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"
import { adminHeaders, type Headers } from "./helpers/admin"

jest.setTimeout(120_000)

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer }) => {
    let admin: Headers
    let ids: Record<string, string>
    const call = (method: "get" | "post" | "put", p: string, body?: unknown) =>
      // axios takes a body before the config on post and put, never on get and delete.
      (api as any)[method](`/admin/royalties-hq${p}`, ...(method === "post" || method === "put" ? [body ?? {}] : []), { ...admin, validateStatus: () => true })

    beforeEach(async () => {
      admin = await adminHeaders(getContainer())
      const { result } = await createProductsWorkflow(getContainer()).run({
        input: {
          products: [
            {
              title: "A Book",
              options: [{ title: "Format", values: ["Hardback", "Paperback", "Box set"] }],
              variants: [
                { title: "Hardback", sku: "9780306406157", options: { Format: "Hardback" }, prices: [{ amount: 20, currency_code: "gbp" }] },
                { title: "Paperback", sku: "PB-1", ean: "9781914195525", options: { Format: "Paperback" }, prices: [{ amount: 10, currency_code: "gbp" }] },
                { title: "Box set", sku: "BOX-1", options: { Format: "Box set" }, prices: [{ amount: 25, currency_code: "gbp" }] },
              ],
            },
          ],
        },
      })
      ids = Object.fromEntries(result[0].variants.map((v: any) => [v.title, v.id]))
    })

    it("lists variants, unticked by default, with the ISBN each would send", async () => {
      const { status, data } = await call("get", "/variants")
      expect(status).toBe(200)
      expect(data.count).toBe(3)
      const byTitle = Object.fromEntries(data.variants.map((v: any) => [v.variant_title, v]))
      expect(byTitle.Hardback).toMatchObject({ id: ids.Hardback, product_title: "A Book", include: false, isbn: "9780306406157", sku: "9780306406157" })
      expect(byTitle.Paperback.isbn).toBe("9781914195525")
      expect(byTitle["Box set"].isbn).toBeNull()
    })

    it("ticks a variant and keeps an override", async () => {
      const { status, data } = await call("post", `/variants/${ids.Hardback}`, { include: true, rhq_product_id: "RHQ-77" })
      expect(status).toBe(200)
      expect(data.variant).toMatchObject({ id: ids.Hardback, include: true, rhq_product_id: "RHQ-77" })
      const listed = (await call("get", "/variants")).data.variants.find((v: any) => v.id === ids.Hardback)
      expect(listed).toMatchObject({ include: true, rhq_product_id: "RHQ-77" })
    })

    it("saves a composition of existing variants and refuses a bad one", async () => {
      const ok = await call("post", `/variants/${ids["Box set"]}`, {
        include: true,
        bundle_components: [{ variant_id: ids.Hardback, quantity: 1 }, { variant_id: ids.Paperback, quantity: 2 }],
      })
      expect(ok.status).toBe(200)
      const bad = await call("post", `/variants/${ids.Hardback}`, { bundle_components: [{ variant_id: ids["Box set"], quantity: 1 }, { variant_id: "variant_missing", quantity: 1 }] })
      expect(bad.status).toBe(400)
      expect(bad.data.errors).toEqual([`cycle:${ids["Box set"]}`, "component_missing:variant_missing"])
      // The admin SDK keeps only the message.
      expect(bad.data.message).toMatch(/contains this variant/)
      expect(bad.data.message).toMatch(/variant_missing/)
    })

    it("ticks many at once", async () => {
      const { status } = await call("post", "/variants/batch", { variant_ids: [ids.Hardback, ids.Paperback], include: true })
      expect(status).toBe(200)
      const included = (await call("get", "/variants")).data.variants.filter((v: any) => v.include).map((v: any) => v.id).sort()
      expect(included).toEqual([ids.Hardback, ids.Paperback].sort())
    })

    it("refuses an unknown variant", async () => {
      expect((await call("post", "/variants/variant_nope", { include: true })).status).toBe(404)
    })
  },
})
