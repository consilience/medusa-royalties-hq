import { createPeriodInputs } from "../period-inputs"
import { ORDER_FIELDS } from "../orders"
import { VARIANT_FIELDS } from "../products"
import { DEFAULT_SETTINGS } from "../../settings/settings"
import { pushHistory } from "../../push/log"

const ORDERS: any[] = require("../../../../tests/fixtures/medusa/allowlisted-orders.json")
const [A, B, C] = ORDERS
const settings = { ...DEFAULT_SETTINGS, timezone: "Europe/London", sale_country: "GB" }

// query.graph stand-in. Candidate searches (fields ["id"]) answer from
// `candidates` by window; full loads answer from the recorded orders by id.
function fakeQuery(candidates: (filters: any) => string[]) {
  const calls: any[] = []
  const graph = async (args: any) => {
    calls.push(args)
    const ids: string[] | undefined = args.filters?.id
    let data: any[] = []
    if (args.entity === "order" && args.fields.length === 1) data = candidates(args.filters).map((id) => ({ id }))
    else if (args.entity === "order") data = ORDERS.filter((o) => ids!.includes(o.id))
    else if (args.entity === "product_variant") data = ids!.map((id) => ({ id, title: id, sku: `SKU-${id.slice(-4)}`, product: { title: "Book" }, prices: [{ currency_code: "eur", raw_amount: { value: "10", precision: 20 }, price_list_id: null, rules_count: 0, min_quantity: null, max_quantity: null }] }))
    return { data, metadata: { count: data.length } }
  }
  return { query: { graph }, calls }
}

const noContexts = async () => new Map()
const variantStore = (rows: any[] = []) => ({ listRhqVariants: async (f: any) => rows.filter((r) => !f.variant_id || f.variant_id.includes(r.variant_id)) })

describe("createPeriodInputs", () => {
  it("looks for the month's orders from its start in the store's zone up to the refund cut-off", async () => {
    const { query, calls } = fakeQuery(() => [])
    await createPeriodInputs({ query, variants: variantStore(), defaultCurrency: "eur" })({
      period: "2026-11",
      settings,
      refundCutoffAt: "2026-12-15T09:00:00+00:00",
      history: pushHistory([], { connectionId: 1 }),
      saleContexts: noContexts,
    })
    const window = calls.find((c) => c.filters?.payment_collections?.payments?.captures)!.filters.payment_collections.payments.captures.created_at
    expect(window.$gte.toISOString()).toBe("2026-11-01T00:00:00.000Z")
    expect(window.$lt.toISOString()).toBe("2026-12-15T09:00:00.000Z")
  })

  it("maps paid orders to the core with their recorded contexts, and leaves unpaid ones out", async () => {
    const unpaid = ORDERS.find((o) => !o.payment_collections[0]?.payments[0]?.captures?.length)!
    const { query } = fakeQuery(() => [A.id, unpaid.id])
    const ctx = { included: {}, bundleSplit: "even" }
    const out = await createPeriodInputs({ query, variants: variantStore(), defaultCurrency: "eur" })({
      period: "2026-11",
      settings,
      refundCutoffAt: "2026-12-15T09:00:00+00:00",
      history: pushHistory([], { connectionId: 1 }),
      saleContexts: async (ids) => new Map(ids.filter((id) => id === A.id).map((id) => [id, { context: ctx as any, frozen: true }])),
    })
    expect(out.orders.map((o) => o.id)).toEqual([A.id])
    expect(out.orders[0]).toMatchObject({ saleContext: ctx, saleContextFrozen: true })
    expect(out.orphanRefunds).toEqual([])
  })

  it("counts refunds in the month on orders that never became a sale, and hands those orders to no one", async () => {
    // Captured in part (never a sale), then refunded: once in November, once in October.
    const partial = structuredClone(A)
    partial.id = "order_partial"
    const pay = partial.payment_collections[0].payments[0]
    pay.captures = [{ id: "capt_p", raw_amount: { value: "10", precision: 20 }, created_at: "2026-11-05T10:00:00.000Z" }]
    pay.refunds = [
      { id: "ref_nov", raw_amount: { value: "10", precision: 20 }, created_at: "2026-11-20T10:00:00.000Z" },
      { id: "ref_oct", raw_amount: { value: "5", precision: 20 }, created_at: "2026-10-20T10:00:00.000Z" },
    ]
    ORDERS.push(partial)
    try {
      const { query } = fakeQuery(() => [A.id, partial.id])
      const out = await createPeriodInputs({ query, variants: variantStore(), defaultCurrency: "eur" })({
        period: "2026-11",
        settings,
        refundCutoffAt: "2026-12-15T09:00:00+00:00",
        history: pushHistory([], { connectionId: 1 }),
        saleContexts: noContexts,
      })
      expect(out.orders.map((o) => o.id)).toEqual([A.id])
      expect(out.refundsOnUnpaidOrders).toBe(1)
    } finally {
      ORDERS.pop()
    }
  })

  it("counts an unpaid order's refund by the month it falls in on the store's clock, up to the month end, not the cut-off", async () => {
    // Europe/Berlin (UTC+1 in November): the month runs from 23:00Z on 31 Oct to 23:00Z on 30 Nov.
    const partial = structuredClone(A)
    partial.id = "order_partial_edges"
    const pay = partial.payment_collections[0].payments[0]
    pay.captures = [{ id: "capt_e", raw_amount: { value: "10", precision: 20 }, created_at: "2026-11-05T10:00:00.000Z" }]
    pay.refunds = [
      { id: "first_instant", raw_amount: { value: "1", precision: 20 }, created_at: "2026-10-31T23:00:00.000Z" },
      // Still 31 Oct in UTC, so a month read on UTC would miss it.
      { id: "first_hour", raw_amount: { value: "1", precision: 20 }, created_at: "2026-10-31T23:30:00.000Z" },
      { id: "last_instant", raw_amount: { value: "1", precision: 20 }, created_at: "2026-11-30T22:59:59.999Z" },
      // After the month, before the cut-off: December's.
      { id: "next_month", raw_amount: { value: "1", precision: 20 }, created_at: "2026-11-30T23:00:00.000Z" },
      // 23:59 on 31 Oct in Berlin: October's.
      { id: "month_before", raw_amount: { value: "1", precision: 20 }, created_at: "2026-10-31T22:59:00.000Z" },
    ]
    ORDERS.push(partial)
    try {
      const { query } = fakeQuery(() => [partial.id])
      const out = await createPeriodInputs({ query, variants: variantStore(), defaultCurrency: "eur" })({
        period: "2026-11",
        settings: { ...settings, timezone: "Europe/Berlin" },
        refundCutoffAt: "2026-12-15T09:00:00+00:00",
        history: pushHistory([], { connectionId: 1 }),
        saleContexts: noContexts,
      })
      expect(out.refundsOnUnpaidOrders).toBe(3)
    } finally {
      ORDERS.pop()
    }
  })

  it("loads product configs for every sold variant and the components of manual bundles", async () => {
    const line = A.items[0].variant_id
    const rows = [{ variant_id: line, include: true, rhq_product_id: null, bundle_components: [{ variant_id: "variant_component", quantity: 2 }] }]
    const { query, calls } = fakeQuery(() => [A.id])
    const out = await createPeriodInputs({ query, variants: variantStore(rows), defaultCurrency: "eur" })({
      period: "2026-11",
      settings,
      refundCutoffAt: "2026-12-15T09:00:00+00:00",
      history: pushHistory([], { connectionId: 1 }),
      saleContexts: noContexts,
    })
    expect(out.products.get(line)).toMatchObject({ included: true, bundleComponents: [{ variantId: "variant_component", quantity: 2 }], regularUnitPrice: 1000n })
    expect(out.products.has("variant_component")).toBe(true)
    expect(calls.filter((c) => c.entity === "product_variant").every((c) => c.fields === VARIANT_FIELDS)).toBe(true)
    expect(calls.filter((c) => c.entity === "order" && c.fields.length > 1).every((c) => c.fields === ORDER_FIELDS)).toBe(true)
  })

  it("also reads sales of earlier pushed months that their pushes did not carry", async () => {
    // October went out carrying B only; C was captured in October too, late.
    const history = pushHistory(
      [{ connection_id: 1, period: "2026-10", mode: "live", status: "imported", refund_cutoff_at: new Date("2026-11-15T09:00:00Z"), pushed_at: new Date("2026-11-15T09:00:05Z"), pushed_refund_ids: [], reported_money_only_refund_ids: [], applied_money_only_refund_ids: [], pushed_order_ids: [B.id] }],
      { connectionId: 1 },
    )
    const { query } = fakeQuery((filters) => {
      const w = filters?.payment_collections?.payments?.captures?.created_at
      // October opens at 23:00Z on 30 September in London (BST).
      return w && w.$gte.toISOString() === "2026-09-30T23:00:00.000Z" ? [B.id, C.id] : []
    })
    const out = await createPeriodInputs({ query, variants: variantStore(), defaultCurrency: "eur" })({
      period: "2026-11",
      settings,
      refundCutoffAt: "2026-12-15T09:00:00+00:00",
      history,
      saleContexts: noContexts,
    })
    expect(out.orders.map((o) => o.id)).toEqual([C.id])
  })

  it("walks back no further than the start month", async () => {
    const pushed = (period: string) => ({ connection_id: 1, period, mode: "live" as const, status: "imported" as const, refund_cutoff_at: new Date(), pushed_at: new Date(), pushed_refund_ids: [], reported_money_only_refund_ids: [], applied_money_only_refund_ids: [], pushed_order_ids: [] })
    const history = pushHistory([pushed("2026-10"), pushed("2026-09"), pushed("2026-08")], { connectionId: 1 })
    const { query, calls } = fakeQuery(() => [])
    await createPeriodInputs({ query, variants: variantStore(), defaultCurrency: "eur" })({
      period: "2026-11",
      settings: { ...settings, start_month: "2026-10" },
      refundCutoffAt: "2026-12-15T09:00:00+00:00",
      history,
      saleContexts: noContexts,
    })
    const starts = calls.map((c) => c.filters?.payment_collections?.payments?.captures?.created_at?.$gte?.toISOString()).filter(Boolean)
    expect(starts).toEqual(["2026-11-01T00:00:00.000Z", "2026-09-30T23:00:00.000Z"])
  })
})
