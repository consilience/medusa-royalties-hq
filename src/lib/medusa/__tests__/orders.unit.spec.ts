import { ORDER_FIELDS, ORDER_CHANGE_FIELDS, candidateOrderIds, loadOrders } from "../orders"

// A query.graph stand-in: answers from a canned list per entity, honouring
// skip/take, and records every call so tests can check what was asked for.
function fakeQuery(data: Record<string, any[]>) {
  const calls: any[] = []
  const graph = async (args: any) => {
    calls.push(args)
    let all = data[args.entity + ":" + JSON.stringify(args.filters ?? {})] ?? data[args.entity] ?? []
    for (const key of ["id", "order_id"]) {
      const wanted = args.filters?.[key]
      if (Array.isArray(wanted)) all = all.filter((row: any) => wanted.includes(row[key]))
    }
    // A query with no pagination may get a default page, so callers must
    // always say how many they want.
    const { skip = 0, take = 15 } = args.pagination ?? {}
    return { data: all.slice(skip, skip + take), metadata: { count: all.length, skip, take } }
  }
  return { graph, calls }
}

describe("the order field list", () => {
  it("asks for nothing that could hold customer data", () => {
    for (const f of [...ORDER_FIELDS, ...ORDER_CHANGE_FIELDS]) {
      expect(f).not.toMatch(/customer|email|address|billing|phone|first_name|last_name|metadata|(^|\.)data(\.|$)|\*/)
    }
  })
  it("asks for every value the reader uses", () => {
    for (const f of [
      "items.raw_quantity",
      "items.raw_unit_price",
      "items.is_tax_inclusive",
      "items.adjustments.raw_amount",
      "items.adjustments.is_tax_inclusive",
      "items.tax_lines.raw_rate",
      "shipping_methods.raw_amount",
      "payment_collections.payments.raw_amount",
      "payment_collections.payments.captures.created_at",
      "payment_collections.payments.refunds.raw_amount",
      "canceled_at",
    ]) {
      expect(ORDER_FIELDS).toContain(f)
    }
  })
})

describe("candidateOrderIds", () => {
  const window = { from: new Date("2026-09-01T00:00:00+01:00"), to: new Date("2026-10-01T00:00:00+01:00") }

  it("finds sales by capture date and adjustments by refund, change and cancellation dates, never by created_at", async () => {
    const q = fakeQuery({})
    await candidateOrderIds(q as any, window)
    const filters = JSON.stringify(q.calls.map((c) => c.filters))
    expect(filters).toContain('"captures":{"created_at"')
    expect(filters).toContain('"refunds":{"created_at"')
    expect(filters).toContain('"canceled_at"')
    expect(q.calls.some((c) => c.entity === "order_change" && c.filters.confirmed_at)).toBe(true)
    expect(q.calls.every((c) => !("created_at" in (c.filters ?? {})))).toBe(true)
  })

  it("pages past 100 and returns each order once, sorted", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `order_${String(i).padStart(3, "0")}` }))
    const q = fakeQuery({ order: many, order_change: [{ order_id: "order_001" }, { order_id: "order_999" }] })
    const ids = await candidateOrderIds(q as any, window)
    expect(ids.length).toBe(251)
    expect(ids[0]).toBe("order_000")
    expect(ids.at(-1)).toBe("order_999")
    expect(q.calls.every((c) => (c.pagination?.take ?? 0) <= 100)).toBe(true)
  })
})

describe("loadOrders", () => {
  it("loads by id in pages of 100 with the allowlisted fields, and their changes", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `order_${i}`)
    const q = fakeQuery({ order: ids.map((id) => ({ id })), order_change: [{ order_id: "order_3", id: "ch1" }] })
    const loaded = await loadOrders(q as any, ids)
    expect(loaded.length).toBe(150)
    expect(loaded.find((l) => l.order.id === "order_3")!.changes).toEqual([{ order_id: "order_3", id: "ch1" }])
    const orderCalls = q.calls.filter((c) => c.entity === "order")
    expect(orderCalls.length).toBe(2)
    expect(orderCalls.every((c) => c.fields === ORDER_FIELDS && c.filters.id.length <= 100)).toBe(true)
    // Explicit: without it Medusa applies its own default page size and a
    // chunk of 100 ids would silently come back short.
    expect(orderCalls.map((c) => c.pagination?.take)).toEqual([100, 50])
  })
})

describe("the field list against a real Medusa 2.22.3 store", () => {
  // allowlisted-orders.json is query.graph({ entity: "order", fields: ORDER_FIELDS })
  // over the recorded store: the reader must see the same sale through the
  // allowlist as through the full field dump recorded from it.
  const { readdirSync, readFileSync } = require("node:fs")
  const { join } = require("node:path")
  const { soldOrder } = require("../sold-lines")
  const dir = join(__dirname, "../../../../tests/fixtures/medusa")
  const allowlisted: any[] = JSON.parse(readFileSync(join(dir, "allowlisted-orders.json"), "utf8"))
  const recorded: [string, any][] = readdirSync(dir)
    .filter((f: string) => /^\d\d[a-z]?-.*(?<!order-changes)\.json$/.test(f))
    .map((f: string): [string, any] => {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8"))
      return [f, Array.isArray(raw) ? raw[0] : raw]
    })

  it("holds only fields the allowlist asks for, so it cannot drift from it", () => {
    const paths = new Set<string>()
    const walk = (v: any, path: string) => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x, path))
      if (v && typeof v === "object" && !("value" in v && "precision" in v)) {
        return Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k))
      }
      paths.add(path)
    }
    allowlisted.forEach((o) => walk(o, ""))
    // Medusa adds each relation's id unasked.
    const unasked = [...paths].filter((p) => !ORDER_FIELDS.includes(p) && !p.endsWith(".id"))
    expect(unasked).toEqual([])
  })

  it.each(recorded)("%s reads the same through the allowlist", (_f: string, full: any) => {
    const narrow = allowlisted.find((o) => o.id === full.id)
    expect(narrow).toBeDefined()
    expect(soldOrder(narrow, [])).toEqual(soldOrder(full, []))
  })
})
