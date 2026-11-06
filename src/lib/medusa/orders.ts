/**
 * Finding and loading the orders a month's snapshot needs. Everything goes
 * through an injected query.graph so this stays testable without a database.
 */

export type Graph = (args: {
  entity: string
  fields: string[]
  filters?: Record<string, unknown>
  pagination?: { skip: number; take: number; order?: Record<string, "ASC" | "DESC"> }
}) => Promise<{ data: any[]; metadata?: { count?: number } }>
export type Query = { graph: Graph }

export const PAGE = 100

/**
 * Every field the reader uses, and nothing else. Spelt out, never `*`: a
 * wildcard would pull in the customer, addresses, metadata and payment
 * `data` (where Stripe keeps billing details), none of which may leave the
 * store or even reach the row builder.
 */
export const ORDER_FIELDS: string[] = [
  "id",
  "status",
  "currency_code",
  "canceled_at",
  "is_draft_order",
  "items.id",
  "items.title",
  "items.product_title",
  "items.variant_id",
  "items.product_id",
  "items.variant_sku",
  "items.variant_barcode",
  "items.variant.sku",
  "items.variant.ean",
  "items.variant.upc",
  "items.variant.barcode",
  "items.quantity",
  "items.raw_quantity",
  "items.raw_unit_price",
  "items.raw_compare_at_unit_price",
  "items.is_tax_inclusive",
  "items.requires_shipping",
  "items.adjustments.raw_amount",
  "items.adjustments.is_tax_inclusive",
  "items.tax_lines.raw_rate",
  "shipping_methods.raw_amount",
  "shipping_methods.is_tax_inclusive",
  "shipping_methods.adjustments.raw_amount",
  "shipping_methods.adjustments.is_tax_inclusive",
  "shipping_methods.tax_lines.raw_rate",
  "payment_collections.payments.raw_amount",
  "payment_collections.payments.canceled_at",
  "payment_collections.payments.created_at",
  "payment_collections.payments.captures.raw_amount",
  "payment_collections.payments.captures.created_at",
  "payment_collections.payments.refunds.id",
  "payment_collections.payments.refunds.raw_amount",
  "payment_collections.payments.refunds.created_at",
]

export const ORDER_CHANGE_FIELDS: string[] = [
  "id",
  "order_id",
  "change_type",
  "status",
  "confirmed_at",
  "actions.action",
  "actions.details",
]

async function allPages(query: Query, args: Omit<Parameters<Graph>[0], "pagination">): Promise<any[]> {
  const out: any[] = []
  for (let skip = 0; ; skip += PAGE) {
    const { data, metadata } = await query.graph({ ...args, pagination: { skip, take: PAGE, order: { id: "ASC" } } })
    out.push(...data)
    const count = metadata?.count
    if (data.length < PAGE || (count !== undefined && skip + PAGE >= count)) return out
  }
}

/**
 * Orders that may matter to a month: sold in it (a capture in the window; the
 * reader keeps those fully paid in it) or adjusted in it (a refund, a confirmed
 * change or a cancellation). Never selected by created_at: a pre-order can be
 * captured months after it is placed.
 *
 * `to` is the month's refund cut-off, not its end: a refund made after the
 * month but before the push belongs in this snapshot. Captures after the
 * month end are over-fetched by the same window, which is harmless because
 * the core books each sale by its paid instant.
 */
export async function candidateOrderIds(query: Query, { from, to }: { from: Date; to: Date }): Promise<string[]> {
  const inWindow = { $gte: from, $lt: to }
  const ids = new Set<string>()
  const orderFilters = [
    { payment_collections: { payments: { captures: { created_at: inWindow } } } },
    { payment_collections: { payments: { refunds: { created_at: inWindow } } } },
    { canceled_at: inWindow },
  ]
  for (const filters of orderFilters) {
    for (const o of await allPages(query, { entity: "order", fields: ["id"], filters })) ids.add(o.id)
  }
  const changes = await allPages(query, {
    entity: "order_change",
    fields: ["id", "order_id"],
    filters: { confirmed_at: inWindow, status: "confirmed" },
  })
  for (const c of changes) if (c.order_id) ids.add(c.order_id)
  return [...ids].sort()
}

/** Each order with its confirmed changes, loaded by id a page at a time. */
export async function loadOrders(query: Query, ids: readonly string[]): Promise<{ order: any; changes: any[] }[]> {
  const out: { order: any; changes: any[] }[] = []
  for (let i = 0; i < ids.length; i += PAGE) {
    const chunk = ids.slice(i, i + PAGE)
    // Paginated explicitly: a query without pagination may get a default
    // page size, which would drop orders from the chunk without a sound.
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ORDER_FIELDS,
      filters: { id: chunk },
      pagination: { skip: 0, take: chunk.length, order: { id: "ASC" } },
    })
    const changes = await allPages(query, {
      entity: "order_change",
      fields: ORDER_CHANGE_FIELDS,
      filters: { order_id: chunk, status: "confirmed" },
    })
    for (const order of orders) out.push({ order, changes: changes.filter((c) => c.order_id === order.id) })
  }
  return out
}
