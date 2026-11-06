import { addMonths, periodEnd, periodStart, type Period } from "../../core/period"
import type { CoreOrder, ProductConfig } from "../../core/types"
import type { VariantStore } from "../admin/variants"
import type { LoadPeriodInputs } from "../push/push"
import { toCoreOrder } from "./core-order"
import { candidateOrderIds, loadOrders, PAGE, type Query } from "./orders"
import { productConfigs, VARIANT_FIELDS, type VariantRow } from "./products"
import { soldOrder } from "./sold-lines"

export type PeriodInputsDeps = {
  query: Query
  variants: Pick<VariantStore, "listRhqVariants">
  /** The store's default currency: product prices only weight bundle splits, so one is enough. */
  defaultCurrency: string
  /** Reader warnings per order, for the status page; never order data. */
  onWarnings?: (orderId: string, warnings: string[]) => void
}

/**
 * Orders paid in committed months before `period` that those months' pushes
 * did not carry. The core re-books such a sale into the first month that can
 * still take it, but only if it is handed the order; nothing else would load
 * an order whose only activity was in a month already closed.
 *
 * The walk stops at the first month that is not committed, or whose carried
 * list is unknown (the core reads an unknown list as "carried everything"),
 * or at the start month.
 */
async function lateSaleIds(query: Query, period: Period, timezone: string, history: Parameters<LoadPeriodInputs>[0]["history"], startMonth: string | null) {
  const ids: string[] = []
  // Nothing before the start month is ever sent, so no sale there is late;
  // the bound also keeps a long-lived store from re-reading years of months.
  for (let p = addMonths(period, -1); history.committedPeriods.has(p) && (!startMonth || p >= startMonth); p = addMonths(p, -1)) {
    const carried = history.ordersAlreadyPushed.get(p)
    if (!carried) break
    const window = { from: new Date(periodStart(p, timezone)), to: new Date(periodEnd(p, timezone)) }
    for (const id of await candidateOrderIds(query, window)) if (!carried.has(id)) ids.push(id)
  }
  return ids
}

async function variantsByIds(query: Query, ids: readonly string[]) {
  const out: any[] = []
  for (let i = 0; i < ids.length; i += PAGE) {
    const { data } = await query.graph({
      entity: "product_variant",
      fields: VARIANT_FIELDS,
      filters: { id: ids.slice(i, i + PAGE) },
      pagination: { skip: 0, take: PAGE },
    })
    out.push(...data)
  }
  return out
}

/**
 * Sold variants plus every component of their manual bundles, down the whole
 * tree: the core splits a bundle line by its components' own configs.
 */
async function loadProducts(deps: PeriodInputsDeps, orders: readonly CoreOrder[], isbnSource: any) {
  const rows = new Map<string, VariantRow>()
  const wanted = new Set(orders.flatMap((o) => o.lines.map((l) => l.variantId).filter((v): v is string => !!v)))
  let pending = [...wanted]
  while (pending.length > 0) {
    const found: VariantRow[] = await deps.variants.listRhqVariants({ variant_id: pending })
    pending = []
    for (const r of found) {
      rows.set(r.variant_id, r)
      for (const c of r.bundle_components ?? []) {
        if (!wanted.has(c.variant_id)) {
          wanted.add(c.variant_id)
          pending.push(c.variant_id)
        }
      }
    }
  }
  const ids = [...wanted].sort()
  if (ids.length === 0) return new Map<string, ProductConfig>()
  return productConfigs(await variantsByIds(deps.query, ids), [...rows.values()], { currency: deps.defaultCurrency, isbnSource })
}

/**
 * The Medusa side of a period build: every order with a sale, refund,
 * cancellation or edit between the month's start and its refund cut-off,
 * plus late sales from earlier months, read through the field allowlist.
 */
export function createPeriodInputs(deps: PeriodInputsDeps): LoadPeriodInputs {
  return async ({ period, settings, refundCutoffAt, history, saleContexts }) => {
    const timezone = settings.timezone ?? "UTC"
    const window = { from: new Date(periodStart(period, timezone)), to: new Date(refundCutoffAt) }
    const ids = [...new Set([...(await candidateOrderIds(deps.query, window)), ...(await lateSaleIds(deps.query, period, timezone, history, settings.start_month))])].sort()
    const loaded = await loadOrders(deps.query, ids)
    const contexts = ids.length ? await saleContexts(ids) : new Map()
    const orders: CoreOrder[] = []
    const month = { from: window.from.getTime(), to: new Date(periodEnd(period, timezone)).getTime() }
    let refundsOnUnpaidOrders = 0
    for (const { order, changes } of loaded) {
      const sold = soldOrder(order, changes)
      if (sold.warnings.length) deps.onWarnings?.(sold.id, sold.warnings)
      const ctx = contexts.get(sold.id)
      const core = toCoreOrder(sold, { saleContext: ctx?.context ?? null, saleContextFrozen: ctx?.frozen ?? false })
      if (core) {
        orders.push(core)
        continue
      }
      // No sale (a partial capture, say), so the core never sees it. A refund
      // on it books nothing, but is said in the summary by its own month.
      refundsOnUnpaidOrders += sold.refunds.filter((r) => {
        const at = new Date(r.createdAt).getTime()
        return at >= month.from && at < month.to
      }).length
    }
    return { orders, orphanRefunds: [], refundsOnUnpaidOrders, products: await loadProducts(deps, orders, settings.isbn_source) }
  }
}
