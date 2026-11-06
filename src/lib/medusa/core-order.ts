import type { CoreOrder, SaleContext } from "../../core/types"
import type { SoldOrder } from "./sold-lines"

/**
 * The core's view of a Medusa order. Null until the order is fully paid: a
 * partial or merely authorised payment is not a sale (the reader warns).
 *
 * Every refund is unlined cash, tax included: a Medusa payment refund carries
 * an amount and nothing else, and nothing ties it to a return.
 * The core's "infer" mode reads units back from the amount.
 */
export function toCoreOrder(
  sold: SoldOrder,
  context: { saleContext?: SaleContext | null; saleContextFrozen?: boolean } = {},
): CoreOrder | null {
  if (!sold.paidAt) return null
  const refunded = sold.refunds.reduce((sum, r) => sum + r.amount, 0n)
  return {
    id: sold.id,
    paidAt: sold.paidAt,
    currency: sold.currency,
    financialStatus: refunded === 0n ? "paid" : refunded >= sold.captured ? "refunded" : "partially_refunded",
    // Medusa has no test orders: a test store is a separate deployment.
    test: false,
    taxesIncluded: sold.taxesIncluded,
    lines: sold.lines,
    shipping: sold.shipping,
    // Medusa records no card fee; the flat fee setting applies.
    fee: null,
    refunds: sold.refunds.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      lines: [],
      shipping: { amount: 0n, tax: 0n },
      unallocatedAmount: r.amount,
    })),
    // Medusa rounds the charge once from the unrounded total, so it can be a
    // minor unit or two under the sum of rounded lines.
    chargedTotal: sold.captured,
    cancelledAt: sold.canceledAt,
    saleContext: context.saleContext ?? null,
    saleContextFrozen: context.saleContextFrozen ?? false,
  }
}
