import type { CoreLine } from "../../core/types"
import { PRECISION, rawToScaled, roundToMinor, toMinor, type RawAmount } from "./money"

/**
 * What a Medusa order sold, at the moment it was paid, in the shape the core
 * reads. Pure: the edge fetches the order and its changes, this only reads them.
 *
 * Medusa stores tax rates, not tax amounts: totals are recomputed at read time
 * at 20 decimal places. We do the same arithmetic on scaled integers and round
 * once per line, so the result agrees with Medusa's own totals to the minor unit.
 */
export type SoldOrder = {
  id: string
  currency: string
  paidAt: string | null
  /** Everything captured on the order, minor units: refunds reaching it make the order refunded. */
  captured: bigint
  canceledAt: string | null
  taxesIncluded: boolean
  lines: CoreLine[]
  shipping: { amount: bigint; tax: bigint }
  refunds: { id: string; createdAt: string; amount: bigint }[]
  warnings: string[]
}

const SCALE = 10n ** BigInt(PRECISION)
const HUNDRED = 100n * SCALE

const sumScaled = (values: RawAmount[]) => values.reduce((s, v) => s + rawToScaled(v), 0n)
const rateOf = (taxLines: any[] | undefined) => sumScaled((taxLines ?? []).map((t) => t.raw_rate))
// query.graph hands back Date objects in memory; Date.parse would go through
// toString and drop the milliseconds, so always go via new Date.
const time = (v: string | Date) => new Date(v).getTime()
const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null)

// items.quantity is a BigNumber in memory; raw_quantity is the plain form.
function quantityOf(item: any): number {
  if (item.raw_quantity === undefined) return item.quantity
  const scaled = rawToScaled(item.raw_quantity)
  if (scaled % SCALE !== 0n) throw new Error(`Line ${item.id} has a fractional quantity`)
  return Number(scaled / SCALE)
}

// Tax on a gross amount in scaled units. Inclusive grosses hold the tax inside
// (gross × r/(100+r)); exclusive ones carry it on top (gross × r/100).
function taxOn(gross: bigint, rate: bigint, inclusive: boolean): bigint {
  if (rate === 0n) return 0n
  return (gross * rate) / (inclusive ? HUNDRED + rate : HUNDRED)
}

type Priced = { unit: bigint; gross: bigint; tax: bigint; rate: bigint; inclusive: boolean }

// `scale` is sold ÷ current quantity: Medusa recomputes a line's adjustments
// for its quantity when an order is edited, so after an edit that changed the
// quantity the stored discount is for the new quantity, not the one sold.
function price(
  unitRaw: RawAmount,
  quantity: number,
  adjustments: any[] | undefined,
  taxLines: any[] | undefined,
  inclusive: boolean,
  scale: [bigint, bigint] = [1n, 1n],
): Priced {
  const unit = rawToScaled(unitRaw)
  const rate = rateOf(taxLines)
  // Only an adjustment's stored raw_amount is read: its raw_total/raw_subtotal
  // are computed totals that query.graph omits unless Medusa decorates totals.
  // The amount is on the adjustment's own basis; convert it to the line's.
  const discount = (adjustments ?? []).reduce((sum, a) => {
    const amount = rawToScaled(a.raw_amount)
    const own = a.is_tax_inclusive === true
    if (own === inclusive) return sum + amount
    return sum + (inclusive ? (amount * (HUNDRED + rate)) / HUNDRED : (amount * HUNDRED) / (HUNDRED + rate))
  }, 0n)
  const gross = unit * BigInt(quantity) - (discount * scale[0]) / scale[1]
  return { unit, gross, tax: taxOn(gross, rate, inclusive), rate, inclusive }
}

// A unit price on the order's basis: ex-tax when an inclusive line sits in a
// mixed order, as it stands otherwise.
function unitOnBasis(scaled: bigint, p: Priced, orderInclusive: boolean, currency: string) {
  return roundToMinor(orderInclusive || !p.inclusive ? scaled : (scaled * HUNDRED) / (HUNDRED + p.rate), currency)
}

/**
 * Express one priced line on the order's basis, in minor units. When the order
 * is mixed we normalise inclusive lines to ex-tax; any rounding residual lands
 * in the discount, so price × qty − discount is always the net Medusa reports.
 */
function onBasis(p: Priced, quantity: number, orderInclusive: boolean, currency: string) {
  const tax = roundToMinor(p.tax, currency)
  if (orderInclusive || !p.inclusive) {
    const unit = roundToMinor(p.unit, currency)
    return { unit, discount: unit * BigInt(quantity) - roundToMinor(p.gross, currency), tax }
  }
  const unit = roundToMinor((p.unit * HUNDRED) / (HUNDRED + p.rate), currency)
  return { unit, discount: unit * BigInt(quantity) - roundToMinor(p.gross - p.tax, currency), tax }
}

/**
 * The instant the order became fully paid: the capture that brought cumulative
 * captures up to what had been asked for by then. Partial capture is not a
 * sale yet. "By then" matters: an edit after payment can add a payment, and
 * judging the first capture against it would move the sale to a later month.
 */
function paidInstant(order: any, warnings: string[]): string | null {
  const payments = (order.payment_collections ?? []).flatMap((c: any) => c.payments ?? []).filter((p: any) => !p.canceled_at)
  if (payments.length === 0) return null
  const captures = payments
    .flatMap((p: any) => p.captures ?? [])
    .sort((a: any, b: any) => time(a.created_at) - time(b.created_at))
  let captured = 0n
  for (const c of captures) {
    captured += rawToScaled(c.raw_amount)
    const at = time(c.created_at)
    const due = sumScaled(payments.filter((p: any) => !p.created_at || time(p.created_at) <= at).map((p: any) => p.raw_amount))
    if (captured >= due) return iso(c.created_at)
  }
  // Held, never booked whole; said out loud so a stuck order is noticed.
  if (captured > 0n) warnings.push("partially_captured")
  return null
}

// Actions that move goods or money but never change what was sold: returns
// reach the snapshot as refunds, and fulfilment is not a sale event.
const ROUTINE_ACTIONS = new Set([
  "FULFILL_ITEM",
  "CANCEL_ITEM_FULFILLMENT",
  "SHIP_ITEM",
  "DELIVER_ITEM",
  "RETURN_ITEM",
  "RECEIVE_RETURN_ITEM",
  "RECEIVE_DAMAGED_RETURN_ITEM",
  "CANCEL_RETURN_ITEM",
  "CREDIT_LINE_ADD",
  "TRANSFER_CUSTOMER",
  "UPDATE_ORDER_PROPERTIES",
])

/**
 * Undo order edits confirmed after payment, so quantities read as sold. Medusa
 * edits items in place; the change log is the only record of what was sold.
 */
function quantityAtPayment(items: any[], changes: any[], paidAt: string | null, warnings: string[]): Map<string, number> {
  const qty = new Map<string, number>(items.map((i) => [i.id, quantityOf(i)]))
  if (!paidAt) return qty
  const paid = time(paidAt)
  for (const change of changes) {
    if (change.status !== "confirmed" || !change.confirmed_at || time(change.confirmed_at) <= paid) continue
    for (const a of change.actions ?? []) {
      if (ROUTINE_ACTIONS.has(a.action)) continue
      const id = a.details?.reference_id
      // The change log keeps the new price only, so the old one cannot be read back.
      if (a.action === "ITEM_UPDATE" && a.details?.unit_price !== undefined) warnings.push(`price_edited_after_payment:${id}`)
      if (a.action === "ITEM_UPDATE" && qty.has(id) && typeof a.details.quantity_diff === "number") qty.set(id, qty.get(id)! - a.details.quantity_diff)
      else if (a.action === "ITEM_ADD" && qty.has(id) && typeof a.details.quantity === "number") qty.set(id, qty.get(id)! - a.details.quantity)
      // Anything else (claims, exchanges, removals, price changes) is read as
      // the order now stands, which may not be what was sold; never silently.
      else warnings.push(`unsupported_change:${change.change_type}/${a.action}`)
    }
  }
  return qty
}

export function soldOrder(order: any, changes: any[]): SoldOrder {
  const currency = String(order.currency_code).toUpperCase()
  const warnings: string[] = []
  const paidAt = paidInstant(order, warnings)
  const items: any[] = order.items ?? []
  const methods: any[] = order.shipping_methods ?? []
  const taxesIncluded = items.length + methods.length > 0 && [...items, ...methods].every((x) => x.is_tax_inclusive === true)
  const quantities = quantityAtPayment(items, changes, paidAt, warnings)

  const lines: CoreLine[] = []
  // query.graph does not promise an item order; sorting keeps the payload
  // bytes, and so its content hash, the same however the order was read.
  for (const item of [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const quantity = quantities.get(item.id)!
    if (quantity <= 0) continue
    if (quantity !== quantityOf(item)) warnings.push(`edited_after_payment:${item.id}`)
    const current = quantityOf(item)
    const p = price(item.raw_unit_price, quantity, item.adjustments, item.tax_lines, item.is_tax_inclusive === true, [
      BigInt(quantity),
      BigInt(current || quantity),
    ])
    const b = onBasis(p, quantity, taxesIncluded, currency)
    lines.push({
      id: item.id,
      variantId: item.variant_id ?? null,
      productId: item.product_id ?? null,
      title: item.product_title ?? item.title ?? "",
      sku: item.variant_sku ?? item.variant?.sku ?? null,
      barcode: item.variant_barcode ?? item.variant?.barcode ?? item.variant?.ean ?? item.variant?.upc ?? null,
      quantity,
      originalUnitPrice: b.unit,
      discountTotal: b.discount,
      tax: b.tax,
      isGiftCard: false,
      requiresShipping: item.requires_shipping !== false,
      group: null,
      // Medusa records the pre-sale price as compare_at when a price list
      // applied; otherwise the unit price is the regular price.
      regularUnitPrice: unitOnBasis(rawToScaled(item.raw_compare_at_unit_price ?? item.raw_unit_price), p, taxesIncluded, currency),
    } as CoreLine)
  }

  let shipAmount = 0n
  let shipTax = 0n
  for (const m of methods) {
    const p = price(m.raw_amount, 1, m.adjustments, m.tax_lines, m.is_tax_inclusive === true)
    const b = onBasis(p, 1, taxesIncluded, currency)
    shipAmount += b.unit - b.discount
    shipTax += b.tax
  }

  const refunds = (order.payment_collections ?? [])
    .flatMap((c: any) => c.payments ?? [])
    .flatMap((p: any) => p.refunds ?? [])
    .map((r: any) => ({ id: r.id, createdAt: iso(r.created_at)!, amount: toMinor(r.raw_amount, currency) }))

  const captured = roundToMinor(
    (order.payment_collections ?? [])
      .flatMap((c: any) => c.payments ?? [])
      .filter((p: any) => !p.canceled_at)
      .flatMap((p: any) => p.captures ?? [])
      .reduce((sum: bigint, c: any) => sum + rawToScaled(c.raw_amount), 0n),
    currency,
  )

  return {
    id: order.id,
    currency,
    paidAt,
    captured,
    canceledAt: iso(order.canceled_at),
    taxesIncluded,
    lines,
    shipping: { amount: shipAmount, tax: shipTax },
    refunds,
    warnings,
  }
}
