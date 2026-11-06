import { readFileSync } from "node:fs"
import { join } from "node:path"
import { soldOrder } from "../sold-lines"
import { toCoreOrder } from "../core-order"
import { productConfigs } from "../products"
import { buildSnapshot } from "../../../core/payload"
import { toCoreSettings, DEFAULT_SETTINGS } from "../../settings/settings"

// Unique strings planted in every customer-shaped field Medusa can return,
// on the order, its lines and its payments. None may come out the other end.
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

describe("customer data never leaves the store", () => {
  it.each(["01-plain-paid", "04-tax-inclusive-usd-promo", "06-money-only-partial-refund", "11-full-money-refund"])(
    "%s: no planted string reaches the reader's output or the payload",
    (name) => {
      const raw = JSON.parse(readFileSync(join(__dirname, "../../../../tests/fixtures/medusa", `${name}.json`), "utf8"))
      const order = plant(Array.isArray(raw) ? raw[0] : raw)
      const sold = soldOrder(order, [])
      const core = toCoreOrder(sold)!
      const products = productConfigs(
        order.items.map((i: any) => ({ id: i.variant_id, title: i.title, sku: i.variant_sku, product: { title: i.product_title }, prices: [] })),
        order.items.map((i: any) => ({ variant_id: i.variant_id, include: true, rhq_product_id: null, bundle_components: null })),
        { currency: sold.currency, isbnSource: "auto" },
      )
      const result = buildSnapshot({
        period: "2026-11",
        orders: [core],
        orphanRefunds: [],
        products,
        settings: toCoreSettings({ ...DEFAULT_SETTINGS, timezone: "Europe/London", sale_country: "GB" }),
        recordedCutoffs: new Map(),
        committedPeriods: new Set(),
        refundsAlreadyPushed: new Map(),
        moneyOnlyRefundsAlreadyReported: new Map(),
        appliedMoneyOnlyRefundIds: new Map(),
        ordersAlreadyPushed: new Map(),
        generatedAt: "2026-12-15T09:00:00+00:00",
        clientVersion: "0.1.0",
        maxRows: 5000,
        unlinedRefunds: "infer",
      })
      // A payload with nothing in it would pass vacuously. Only the order
      // refunded in full in its own month rightly sends no rows.
      if (name !== "11-full-money-refund") expect(result.payload.rows.length).toBeGreaterThan(0)
      const out = JSON.stringify([sold, core, result], (_k, v) => (typeof v === "bigint" ? String(v) : v instanceof Map ? [...v] : v))
      for (const s of SENTINELS) expect(out).not.toContain(s)
    },
  )
})
