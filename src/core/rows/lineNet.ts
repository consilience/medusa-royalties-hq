import type { Minor } from "../money";
import type { CoreOrder } from "../types";
import { computeDeductions, removeTax, type NetSettings } from "./deductions";

export type { NetSettings } from "./deductions";

/** Per-line breakdown of a sale; all bigint minor units of the order currency. */
export interface LineNet {
  lineId: string;
  /** originalUnitPrice × quantity − discountTotal, on the order's tax basis. */
  gross: Minor;
  discount: Minor;
  exTax: Minor;
  commission: Minor;
  fees: Minor;
  /** This line's share of shipping ex tax; 0 unless includeShipping. */
  shipping: Minor;
  /** exTax − commission − fees + shipping → royalty_on_sales. */
  net: Minor;
}

export interface OrderLineNets {
  orderId: string;
  lines: LineNet[];
  feeFallback: boolean;
  flatFeeMissing: boolean;
  unallocatedShipping: Minor;
  /** Lines whose net would have flipped sign (summary.nets_clamped). */
  netsClamped: number;
}

/**
 * Net per line for one order's sale.
 *
 * Gift-card lines are dropped before anything else: selling a gift card is
 * not book revenue, and leaving them in would make them soak up a share of
 * the fee and shipping that belongs to the books.
 *
 * Every other line is returned, including unticked products. Their share of
 * fees and shipping must still be computed so ticked lines do not absorb it;
 * the caller drops unticked lines afterwards.
 */
export function computeLineNets(
  order: CoreOrder,
  settings: NetSettings,
): OrderLineNets {
  const lines = order.lines.filter((l) => !l.isGiftCard);

  const gross = lines.map(
    (l) => l.originalUnitPrice * BigInt(l.quantity) - l.discountTotal,
  );
  const exTax = lines.map((l, i) =>
    removeTax(gross[i]!, l.tax, order.taxesIncluded),
  );
  const shippingExTax = removeTax(
    order.shipping.amount,
    order.shipping.tax,
    order.taxesIncluded,
  );

  const d = computeDeductions(
    exTax,
    // A tax-inclusive gross already is the charge; a tax-exclusive one adds
    // the tax the customer paid on top.
    lines.map((l, i) => (order.taxesIncluded ? gross[i]! : gross[i]! + l.tax)),
    lines.map((l) => l.quantity),
    shippingExTax,
    order.fee,
    settings,
    "sale",
  );

  return {
    orderId: order.id,
    lines: lines.map((l, i) => ({
      lineId: l.id,
      gross: gross[i]!,
      discount: l.discountTotal,
      exTax: exTax[i]!,
      commission: d.commission[i]!,
      fees: d.fees[i]!,
      shipping: d.shipping[i]!,
      net: exTax[i]! - d.commission[i]! - d.fees[i]! + d.shipping[i]!,
    })),
    feeFallback: d.feeFallback,
    flatFeeMissing: d.flatFeeMissing,
    unallocatedShipping: d.unallocatedShipping,
    netsClamped: d.netsClamped,
  };
}
