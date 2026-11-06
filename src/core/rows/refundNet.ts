import type { Minor } from "../money";
import type { CoreLine, CoreOrder, CoreRefund } from "../types";
import { computeDeductions, removeTax, type NetSettings } from "./deductions";
import { allocateByMagnitude } from "./fees";
import { computeLineNets } from "./lineNet";

/** Per-line breakdown of a refund; money ≤ 0, units ≥ 0. */
export interface RefundLineNet {
  lineId: string;
  /** Refunded quantity → units_refunded (a count, so positive). */
  units: number;
  /** −amount, on the order's tax basis. */
  gross: Minor;
  exTax: Minor;
  commission: Minor;
  fees: Minor;
  shipping: Minor;
  /** exTax − commission − fees + shipping → royalty_on_refunds. */
  net: Minor;
}

export interface RefundLineNets {
  refundId: string;
  orderId: string;
  lines: RefundLineNet[];
  feeFallback: boolean;
  flatFeeMissing: boolean;
  unallocatedShipping: Minor;
  /** Lines whose net would have flipped sign (summary.nets_clamped). */
  netsClamped: number;
}

/**
 * Net per refunded line.
 *
 * The refund's amounts are negated first and then sent through the very same
 * tax/commission/fee/shipping steps as a sale. Because every rounding step
 * in the core is symmetric about zero (half away from zero, largest remainder
 * on magnitudes), a full refund reproduces each sale figure with its sign
 * flipped and the pair nets to exactly 0 per line.
 *
 * `settings` are the ones current when the snapshot is built (the refund's own
 * date), not those the sale was built with: there is no retroactive
 * recomputation. The actual-fee ratio is the original order's, since a refund
 * reverses that charge.
 *
 * Refunded discount is not reported: the refund amount is already net of the
 * line's discount, and the breakdown's discount column is sales-side only.
 */
export function computeRefundNets(
  order: CoreOrder,
  refund: CoreRefund,
  settings: NetSettings,
): RefundLineNets {
  const byId = new Map<string, CoreLine>(order.lines.map((l) => [l.id, l]));
  const refunded = refund.lines.filter((r) => {
    const original = byId.get(r.lineId);
    if (original === undefined) {
      // The ledger holds the whole order, so a missing line means the ledger
      // is inconsistent. Guessing its tax basis or gift-card status could
      // pay royalties on a gift card; fail loudly instead.
      throw new Error(
        `Refund ${refund.id} refers to line ${r.lineId}, which is not on order ${order.id}`,
      );
    }
    return !original.isGiftCard;
  });

  const gross = refunded.map((r) => -r.amount);
  const exTax = refunded.map((r, i) =>
    removeTax(gross[i]!, -r.tax, order.taxesIncluded),
  );
  const shippingExTax = -removeTax(
    refund.shipping.amount,
    refund.shipping.tax,
    order.taxesIncluded,
  );

  const d = computeDeductions(
    exTax,
    refunded.map((r, i) =>
      order.taxesIncluded ? gross[i]! : gross[i]! - r.tax,
    ),
    refunded.map((r) => r.quantity),
    shippingExTax,
    order.fee,
    settings,
    "refund",
  );

  const lines: RefundLineNet[] = refunded.map((r, i) => ({
    lineId: r.lineId,
    units: r.quantity,
    gross: gross[i]!,
    exTax: exTax[i]!,
    commission: d.commission[i]!,
    fees: d.fees[i]!,
    shipping: d.shipping[i]!,
    net: exTax[i]! - d.commission[i]! - d.fees[i]! + d.shipping[i]!,
  }));

  let unallocatedShipping = d.unallocatedShipping;
  if (unallocatedShipping !== 0n) {
    unallocatedShipping = placeOnSaleLines(
      order,
      settings,
      unallocatedShipping,
      lines,
    );
  }

  return {
    refundId: refund.id,
    orderId: order.id,
    lines,
    feeFallback: d.feeFallback,
    flatFeeMissing: d.flatFeeMissing,
    unallocatedShipping,
    netsClamped: d.netsClamped,
  };
}

/**
 * Refunded shipping that the refunded lines could not carry: typically a
 * shipping-only refund, which has no lines at all. The sale spread that
 * shipping over the order's lines by ex-tax, so the refund
 * is spread the same way, with zero units: dropping it would leave the author
 * paid on shipping the customer got back. Units stay at zero because no book
 * came back; aggregation's refund-money-without-units rule
 * decides where the money lands. Only reached with includeShipping on, since
 * computeDeductions leaves shipping unallocated only then.
 *
 * Mutates `lines` (adding to an existing entry for the same line, else
 * appending one) and returns what is still unallocated: non-zero only when
 * the order has no non-gift-card line to carry it.
 */
function placeOnSaleLines(
  order: CoreOrder,
  settings: NetSettings,
  shipping: Minor,
  lines: RefundLineNet[],
): Minor {
  const quantityOf = new Map(order.lines.map((l) => [l.id, l.quantity]));
  // The sale's own ex-tax per line, from the same function the sale used, so
  // the weights cannot drift from the ones its shipping was spread by.
  const sale = computeLineNets(order, settings).lines;
  const shares = allocateByMagnitude(
    shipping,
    sale.map((l) => l.exTax),
    sale.map((l) => quantityOf.get(l.lineId)!),
  );
  if (shares === null) return shipping;

  sale.forEach((l, i) => {
    const share = shares[i]!;
    if (share === 0n) return;
    const existing = lines.find((x) => x.lineId === l.lineId);
    if (existing !== undefined) {
      existing.shipping += share;
      existing.net += share;
      return;
    }
    lines.push({
      lineId: l.lineId,
      units: 0,
      gross: 0n,
      exTax: 0n,
      commission: 0n,
      fees: 0n,
      shipping: share,
      net: share,
    });
  });
  return 0n;
}
