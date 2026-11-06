import { readFileSync } from "node:fs"
import { join } from "node:path"
import { soldOrder } from "../sold-lines"
import { toCoreOrder } from "../core-order"
import { buildSnapshot } from "../../../core/payload"
import { toCoreSettings, DEFAULT_SETTINGS } from "../../settings/settings"

const FIXTURES = join(__dirname, "../../../../tests/fixtures/medusa")
const load = (name: string) => {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"))
  return Array.isArray(raw) ? raw[0] : raw
}
const sold = (name: string) => soldOrder(load(name), [])

describe("toCoreOrder", () => {
  it("is null for an order that was never fully paid", () => {
    expect(toCoreOrder(sold("05-authorised-not-captured"))).toBeNull()
  })

  it("carries the sale as paid, real, with no fee recorded", () => {
    const o = toCoreOrder(sold("01-plain-paid"))!
    expect(o).toMatchObject({ financialStatus: "paid", test: false, fee: null, currency: "EUR", cancelledAt: null })
    expect(o.paidAt).toBe(sold("01-plain-paid").paidAt)
  })

  it("reads every refund as unlined cash, tax included", () => {
    const o = toCoreOrder(sold("06-money-only-partial-refund"))!
    expect(o.financialStatus).toBe("partially_refunded")
    expect(o.refunds).toEqual([
      { id: expect.any(String), createdAt: expect.any(String), lines: [], shipping: { amount: 0n, tax: 0n }, unallocatedAmount: 750n },
    ])
  })

  it("marks a fully refunded order refunded, and keeps its cancellation", () => {
    expect(toCoreOrder(sold("11-full-money-refund"))!.financialStatus).toBe("refunded")
    expect(toCoreOrder(sold("09-captured-then-cancelled"))!.cancelledAt).toBe(sold("09-captured-then-cancelled").canceledAt)
  })

  it("gives the core what was charged, so a refund of the whole charge is a full return", () => {
    const s = sold("01-plain-paid")
    expect(toCoreOrder(s)!.chargedTotal).toBe(s.captured)
  })

  it("passes the recorded sale context through", () => {
    const ctx = { included: {}, bundleSplit: "even" } as any
    expect(toCoreOrder(sold("01-plain-paid"), { saleContext: ctx, saleContextFrozen: true })).toMatchObject({ saleContext: ctx, saleContextFrozen: true })
  })
})

describe("a recorded Medusa order through the core", () => {
  // This order is refunded in full in the month it was sold, before the cut-off,
  // so the refund lowers the sale itself. Only inference
  // reads the cash as the books coming back: without it the units stay sold.
  const build = (unlinedRefunds: "infer" | "spread") => {
    const order = toCoreOrder(sold("11-full-money-refund"))!
    const products = new Map(
      order.lines.map((l) => [
        l.variantId!,
        { variantId: l.variantId!, included: true, rhqProductId: null, isbnSourceValue: null, sku: l.sku, asin: null, title: l.title, regularUnitPrice: null, bundleComponents: null },
      ]),
    )
    return buildSnapshot({
      period: "2026-11",
      orders: [order],
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
      unlinedRefunds,
    }).payload
  }

  it("reads a full money refund as a full return, so the month sends nothing", () => {
    const payload = build("infer")
    expect(payload.summary).toMatchObject({ orders_included: 1, refunds_included: 1 })
    expect(payload.rows).toEqual([])
  })

  it("would otherwise keep the units sold with the money taken off", () => {
    const rows = build("spread").rows
    expect(rows.map((r) => [r.units_sold, r.royalty_on_sales])).toEqual([[2, "0.00"]])
  })
})
