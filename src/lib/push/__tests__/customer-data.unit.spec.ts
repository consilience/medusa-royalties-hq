import { readFileSync } from "node:fs"
import { join } from "node:path"

import { toCoreOrder } from "../../medusa/core-order"
import { productConfigs } from "../../medusa/products"
import { soldOrder } from "../../medusa/sold-lines"
import { snapshotData } from "../../rhq/__tests__/support/fakeRhq"
import { pushPeriod, type LoadPeriodInputs } from "../push"
import { accepted, LIVE_TOKEN, pushWorld, rhqStub } from "./support/world"

// The reader's sentinel test (src/lib/medusa/__tests__/customer-data) carried
// through the push step: recorded Medusa orders with unique strings planted
// in every customer-shaped field are read, built, pushed to a fake RHQ and
// recorded. No planted string reaches a request, a logger call, an attempt,
// a stored snapshot or any other stored row. Nor does the token reach a
// logger call or a stored row.

const SENTINELS = ["SENTINEL-NAME-7f3a", "sentinel-7f3a@example.test", "SENTINEL-STREET-7f3a", "SENTINEL-PHONE-7f3a", "SENTINEL-CARD-7f3a", "SENTINEL-META-7f3a"]
const [NAME, EMAIL, STREET, PHONE, CARD, META] = SENTINELS

function plant(order: any) {
  const address = { first_name: NAME, last_name: NAME, address_1: STREET, phone: PHONE, postal_code: STREET }
  return {
    ...order,
    email: EMAIL,
    customer: { id: "cus_1", email: EMAIL, first_name: NAME, last_name: NAME, phone: PHONE },
    shipping_address: address,
    billing_address: address,
    metadata: { note: META },
    items: order.items.map((i: any) => ({ ...i, metadata: { gift_message: META }, subtitle: NAME })),
    payment_collections: order.payment_collections.map((c: any) => ({
      ...c,
      payments: c.payments.map((p: any) => ({ ...p, data: { billing_details: { name: NAME, email: EMAIL, address: { line1: STREET } }, card: CARD } })),
    })),
  }
}

const FIXTURES = ["01-plain-paid", "04-tax-inclusive-usd-promo", "06-money-only-partial-refund", "11-full-money-refund"]

function plantedOrders() {
  return FIXTURES.map((name) => {
    const raw = JSON.parse(readFileSync(join(__dirname, "../../../../tests/fixtures/medusa", `${name}.json`), "utf8"))
    return plant(Array.isArray(raw) ? raw[0] : raw)
  })
}

/** The Medusa reader end to end, over planted orders. */
function readerLoader(orders: any[]): LoadPeriodInputs {
  return async ({ settings, saleContexts }) => {
    const sold = orders.map((o) => soldOrder(o, []))
    const contexts = await saleContexts(sold.map((s) => s.id))
    const core = sold.map((s) => toCoreOrder(s, { saleContext: contexts.get(s.id)?.context, saleContextFrozen: contexts.get(s.id)?.frozen })).filter((o) => o !== null)
    const products = new Map()
    for (const currency of new Set(sold.map((s) => s.currency))) {
      const items = orders.filter((o) => o.currency_code.toUpperCase() === currency).flatMap((o) => o.items)
      const configs = productConfigs(
        items.map((i: any) => ({ id: i.variant_id, title: i.title, sku: i.variant_sku, product: { title: i.product_title }, prices: [] })),
        items.map((i: any) => ({ variant_id: i.variant_id, include: true, rhq_product_id: null, bundle_components: null })),
        { currency, isbnSource: settings.isbn_source },
      )
      for (const [k, v] of configs) products.set(k, v)
    }
    return { orders: core, orphanRefunds: [], products }
  }
}

const dump = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x instanceof Map ? [...x] : x))

describe("customer data and the token never leave through the push step", () => {
  it("plants nowhere: requests, logger calls, attempts, snapshots, sale contexts or state", async () => {
    const rhq = rhqStub({
      writes: [
        { status: 202, body: { data: snapshotData({ result: "created", import_id: null, period: "2026-11" }), dry_run: true } },
        accepted("created", { period: "2026-11" }),
      ],
    })
    const w = pushWorld({ rhq, now: "2026-12-20T12:00:00.000Z", settings: { isbn_source: "auto" } })
    w.deps.loadPeriodInputs = readerLoader(plantedOrders())

    expect(await pushPeriod(w.deps, "2026-11", { mode: "validate", trigger: "manual" })).toMatchObject({ kind: "accepted" })
    expect(await pushPeriod(w.deps, "2026-11", { mode: "live", trigger: "manual" })).toMatchObject({ kind: "accepted" })
    // The push really carried the planted orders' sales.
    expect(JSON.parse(rhq.sent.find((r) => r.method === "PUT")!.body!).rows.length).toBeGreaterThan(0)
    expect(w.logs.length).toBeGreaterThan(0)

    const requests = dump(rhq.sent.map((r) => ({ url: r.url, body: r.body })))
    const logs = dump(w.logs)
    const stored = dump(w.store.data)
    const notices = dump(w.notices)
    for (const s of SENTINELS) {
      expect(requests).not.toContain(s)
      expect(logs).not.toContain(s)
      expect(stored).not.toContain(s)
      expect(notices).not.toContain(s)
    }
    for (const where of [logs, stored, notices]) {
      expect(where).not.toContain(LIVE_TOKEN)
      // Nor a recognisable part of it.
      expect(where).not.toContain(LIVE_TOKEN.slice(0, 20))
    }
  })

  it("keeps the token out of logs and rows when RHQ refuses it", async () => {
    const rhq = rhqStub({ handshake: { status: 401, body: { type: "urn:royaltieshq:problem:unauthenticated", title: "Authentication required.", status: 401, code: "unauthenticated", detail: null } } })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", { mode: "live", trigger: "manual" })
    expect(dump(w.logs)).not.toContain(LIVE_TOKEN.slice(0, 20))
    expect(dump(w.store.data)).not.toContain(LIVE_TOKEN.slice(0, 20))
  })
})
