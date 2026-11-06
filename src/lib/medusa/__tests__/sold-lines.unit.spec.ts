import { readFileSync } from "node:fs"
import { join } from "node:path"
import { soldOrder } from "../sold-lines"
import { toMinor } from "../money"

const FIXTURES = join(__dirname, "../../../../tests/fixtures/medusa")
const load = (name: string) => {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"))
  return Array.isArray(raw) ? raw[0] : raw
}
const changes = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.order-changes.json`), "utf8"))

// Orders with no return, edit or refund: Medusa's own computed totals are the
// oracle for what was sold, rounded once to the minor unit.
const CLEAN = ["01-plain-paid", "02-promotion", "03-tax-exclusive", "04-tax-inclusive-usd-promo", "04a-usd-promo-tax-exclusive"]

describe("soldOrder on orders nothing has changed since capture", () => {
  it.each(CLEAN)("%s: each line's ex-tax net and tax equal Medusa's own totals", (name) => {
    const order = load(name)
    const sold = soldOrder(order, [])
    const cur = order.currency_code.toUpperCase()
    for (const item of order.items) {
      const line = sold.lines.find((l) => l.id === item.id)!
      const gross = line.originalUnitPrice * BigInt(line.quantity) - line.discountTotal
      const exTax = sold.taxesIncluded ? gross - line.tax : gross
      expect({ id: item.id, exTax, tax: line.tax }).toEqual({
        id: item.id,
        exTax: toMinor(item.raw_total, cur) - toMinor(item.raw_tax_total, cur),
        tax: toMinor(item.raw_tax_total, cur),
      })
    }
    const shipExTax = sold.taxesIncluded ? sold.shipping.amount - sold.shipping.tax : sold.shipping.amount
    const ship = order.shipping_methods
    expect(shipExTax).toBe(ship.reduce((s: bigint, m: any) => s + toMinor(m.raw_total, cur) - toMinor(m.raw_tax_total, cur), 0n))
  })

  it("takes the tax basis from the lines: inclusive when every line and shipping method is", () => {
    expect(soldOrder(load("04-tax-inclusive-usd-promo"), []).taxesIncluded).toBe(true)
    expect(soldOrder(load("03-tax-exclusive"), []).taxesIncluded).toBe(false)
  })

  it("keeps the price as charged on an inclusive order: £15 a unit, £3 off, tax inside", () => {
    const line = soldOrder(load("04-tax-inclusive-usd-promo"), []).lines[0]
    expect(line).toMatchObject({ quantity: 2, originalUnitPrice: 1500n, discountTotal: 300n, tax: 245n })
  })

  it("reads identifiers as sold and never a gift card or a bundle group", () => {
    const order = load("03-tax-exclusive")
    const line = soldOrder(order, []).lines[0]
    expect(line).toMatchObject({
      variantId: order.items[0].variant_id,
      productId: order.items[0].product_id,
      sku: order.items[0].variant_sku,
      isGiftCard: false,
      group: null,
    })
  })
})

describe("soldOrder after an order edit", () => {
  it("reads the quantity as it stood at capture, before an edit confirmed afterwards", () => {
    const order = load("10-order-edit-reduce-qty")
    const sold = soldOrder(order, changes("10-order-edit-reduce-qty"))
    expect(order.items[0].quantity).toBe(1)
    expect(sold.lines[0].quantity).toBe(3)
  })

  it("keeps a quantity changed by an edit confirmed before capture", () => {
    const order = load("10-order-edit-reduce-qty")
    const edits = changes("10-order-edit-reduce-qty").map((c: any) => ({ ...c, confirmed_at: "2026-01-01T00:00:00.000Z" }))
    expect(soldOrder(order, edits).lines[0].quantity).toBe(1)
  })
})

describe("soldOrder payment state", () => {
  it("is paid at the capture that completes the payment", () => {
    const order = load("01-plain-paid")
    const capture = order.payment_collections[0].payments[0].captures[0]
    expect(soldOrder(order, []).paidAt).toBe(new Date(capture.created_at).toISOString())
  })

  it("is not paid when only authorised", () => {
    expect(soldOrder(load("05-authorised-not-captured"), []).paidAt).toBeNull()
  })

  it("reads every refund as money only, with its own date", () => {
    const sold = soldOrder(load("06-money-only-partial-refund"), [])
    expect(sold.refunds).toEqual([
      expect.objectContaining({ amount: 750n, createdAt: expect.stringMatching(/Z$/) }),
    ])
  })

  it("records the cancellation instant", () => {
    const order = load("09-captured-then-cancelled")
    expect(soldOrder(order, []).canceledAt).toBe(new Date(order.canceled_at).toISOString())
  })
})

describe("soldOrder on a mixed tax basis", () => {
  it("normalises an inclusive line to ex-tax when shipping is exclusive, keeping Medusa's net", () => {
    const order = load("04-tax-inclusive-usd-promo")
    order.shipping_methods = order.shipping_methods.map((m: any) => ({ ...m, is_tax_inclusive: false }))
    const sold = soldOrder(order, [])
    const item = order.items[0]
    const line = sold.lines[0]
    expect(sold.taxesIncluded).toBe(false)
    expect(line.originalUnitPrice * BigInt(line.quantity) - line.discountTotal).toBe(
      toMinor(item.raw_total, "USD") - toMinor(item.raw_tax_total, "USD"),
    )
    expect(line.tax).toBe(245n)
  })
})

describe("soldOrder on values as query.graph returns them in memory", () => {
  // Before JSON serialisation dates are Date objects and quantities BigNumber
  // objects (FIELDS.md); only raw_* are plain.
  const inMemory = (order: any) => {
    const bigNumber = (n: number) => ({ numeric: n, toJSON: () => n, valueOf: () => { throw new Error("BigNumber is not a number") } })
    const capture = order.payment_collections[0].payments[0].captures[0]
    return {
      ...order,
      canceled_at: order.canceled_at ? new Date(order.canceled_at) : null,
      items: order.items.map((i: any) => ({ ...i, quantity: bigNumber(i.quantity) })),
      payment_collections: [{ ...order.payment_collections[0], payments: [{ ...order.payment_collections[0].payments[0], captures: [{ ...capture, created_at: new Date(capture.created_at) }] }] }],
    }
  }

  it("reads quantity from raw_quantity and keeps the capture's milliseconds", () => {
    const order = load("10-order-edit-reduce-qty")
    const capture = order.payment_collections[0].payments[0].captures[0]
    const sold = soldOrder(inMemory(order), changes("10-order-edit-reduce-qty").map((c: any) => ({ ...c, confirmed_at: new Date(c.confirmed_at) })))
    expect(sold.paidAt).toBe(new Date(capture.created_at).toISOString())
    expect(sold.lines[0].quantity).toBe(3)
  })
})

describe("soldOrder warnings", () => {
  it("reports a partial capture instead of reading it as unpaid", () => {
    const order = load("01-plain-paid")
    const payment = order.payment_collections[0].payments[0]
    const half = { ...payment, captures: [{ ...payment.captures[0], raw_amount: { value: "1", precision: 20 } }] }
    const sold = soldOrder({ ...order, payment_collections: [{ ...order.payment_collections[0], payments: [half] }] }, [])
    expect(sold.paidAt).toBeNull()
    expect(sold.warnings).toContain("partially_captured")
  })

  it("stays quiet about returns, fulfilment and credit lines", () => {
    for (const name of ["07-return-with-refund", "08-return-no-refund", "06-money-only-partial-refund"]) {
      expect(soldOrder(load(name), changes(name)).warnings).toEqual([])
    }
  })

  it("flags a change after payment it cannot undo, such as a claim", () => {
    const order = load("01-plain-paid")
    const claim = [{ id: "ch1", order_id: order.id, change_type: "claim", status: "confirmed", confirmed_at: "2099-01-01T00:00:00Z", actions: [{ action: "ITEM_REMOVE", details: { reference_id: order.items[0].id } }] }]
    expect(soldOrder(order, claim).warnings).toEqual(["unsupported_change:claim/ITEM_REMOVE"])
  })
})

describe("soldOrder regular price", () => {
  // Refund-only rows report only this as list_price, so it must be what the
  // book cost before any sale, as recorded on the order, never today's price.
  it("is the unit price when no sale applied", () => {
    const line = soldOrder(load("03-tax-exclusive"), []).lines[0]
    expect(line.regularUnitPrice).toBe(line.originalUnitPrice)
  })
  it("is the compare-at price a price-list sale recorded", () => {
    const order = load("03-tax-exclusive")
    order.items = order.items.map((i: any) => ({ ...i, raw_compare_at_unit_price: { value: "14.5", precision: 20 } }))
    expect(soldOrder(order, []).lines[0].regularUnitPrice).toBe(1450n)
  })
})

describe("soldOrder after an edit changes what was paid for", () => {
  const after = "2099-01-01T00:00:00.000Z"
  const edit = (order: any, actions: any[]) => [{ id: "ch_edit", order_id: order.id, change_type: "edit", status: "confirmed", confirmed_at: after, actions }]

  it("scales a line's discount back to the quantity sold, as Medusa recomputes it for the new quantity", () => {
    // 02: three at 10 with 3 off. Edited after payment to four, Medusa holds 4 off.
    const order = load("02-promotion")
    const item = order.items[0]
    const edited = {
      ...order,
      items: [{ ...item, quantity: 4, raw_quantity: { value: "4", precision: 20 }, adjustments: [{ ...item.adjustments[0], raw_amount: { value: "4", precision: 20 } }] }],
    }
    const sold = soldOrder(edited, edit(order, [{ action: "ITEM_UPDATE", details: { reference_id: item.id, quantity: 4, quantity_diff: 1 } }]))
    const original = soldOrder(order, []).lines[0]
    expect(sold.lines[0]).toMatchObject({ quantity: 3, discountTotal: original.discountTotal, originalUnitPrice: original.originalUnitPrice })
  })

  it("keeps the sale at the first full capture when an edit later adds a payment", () => {
    const order = load("01-plain-paid")
    const payment = order.payment_collections[0].payments[0]
    const extra = { ...payment, id: "pay_extra", created_at: "2099-01-01T00:00:00Z", raw_amount: { value: "5", precision: 20 }, captures: [{ id: "capt_extra", raw_amount: { value: "5", precision: 20 }, created_at: "2099-01-02T00:00:00Z" }], refunds: [] }
    const withExtra = { ...order, payment_collections: [{ ...order.payment_collections[0], payments: [payment, extra] }] }
    expect(soldOrder(withExtra, []).paidAt).toBe(new Date(payment.captures[0].created_at).toISOString())
  })

  it("warns when an edit after payment changed a line's price", () => {
    const order = load("01-plain-paid")
    const item = order.items[0]
    const sold = soldOrder(order, edit(order, [{ action: "ITEM_UPDATE", details: { reference_id: item.id, quantity: item.quantity, quantity_diff: 0, unit_price: 99 } }]))
    expect(sold.warnings).toContain(`price_edited_after_payment:${item.id}`)
  })
})
