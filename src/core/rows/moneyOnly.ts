import type { EffectiveLine } from "../bundles";
import { mulDivRound, type Minor } from "../money";
import type { CoreOrder } from "../types";
import { computeDeductions, removeTax, type NetSettings } from "./deductions";
import { allocateByMagnitude } from "./fees";

export interface SaleAdjustmentResult {
  lines: EffectiveLine[];
  /** Adjustment lines whose fee was cut back so the adjustment kept its sign. */
  netsClamped: number;
  /** Money no line could carry (the order has no line with value or units); not applied. */
  unplaced: Minor;
}

/**
 * Lowers an order's sale by money-only refund money made before the sale's
 * period went out. Such money has no line, so it
 * is treated as a price reduction on the sale: a refund row would need
 * refunded units, and inventing one would claw back a whole unit's royalty.
 *
 * `refunded` is the cash that went back, TAX INCLUDED whatever the order's
 * tax basis (a platform splits no tax out of money that belongs to no line;
 * Medusa's refunds are bare amounts), positive when the customer got money
 * back. It is spread over everything the order charged (see below), and
 * the books' shares over the EFFECTIVE sale lines (after any bundle split,
 * so a component carries its share of the bundle's reduction exactly as it
 * carries its share of the price) by each line's value after discount,
 * largest remainder, with units as the weight when every line is free.
 * Unticked lines take part in the weights so ticked ones do not absorb their
 * share; that share only lowers the unticked revenue reported, and is never
 * sent.
 *
 * Each share is cash, so it is taken ex tax by the ratio of its source
 * lines' ex-tax to the cash they were charged (ex-tax + recorded tax, on
 * either basis) of the real lines it came from: the line's own tax rate, the
 * whole group's for a re-weighted bundle's components (their money was
 * pooled), the order's for a free line, and as is
 * when the whole order is free. That share is then sent through the refund
 * side of the same commission and fee steps: the reduction takes back the
 * deductions made on the money it removes, so the net falls by the
 * adjustment's net, not by its cash. Shipping is not touched. It is booked
 * as extra discount on the order's tax basis, so the breakdown's gross −
 * discount still equals the line's ex-tax amount.
 *
 * The result is new line objects: the caller's resolved lines are cached and
 * shared with the order's refunds, so they must not be mutated.
 */
export function applySaleAdjustment(
  lines: readonly EffectiveLine[],
  refunded: Minor,
  order: Pick<CoreOrder, "fee" | "lines" | "taxesIncluded" | "shipping">,
  settings: NetSettings,
  /**
   * false when the unlined refunds were already matched to the order's own
   * lines (unlinedRefunds "infer"): whatever money is left here matched no
   * single charge there, so matching it again against the effective lines,
   * whose amounts differ (one line of two units, a bundle's components),
   * could pick a line the order-level reading found ambiguous.
   */
  matchWholeCharges = true,
): SaleAdjustmentResult {
  if (refunded === 0n) {
    return { lines: [...lines], netsClamped: 0, unplaced: 0n };
  }
  // Spread over everything the order charged: gift cards and, when
  // shipping is excluded, the shipping take their shares, which are then
  // dropped as gift cards and excluded shipping are. Included shipping is
  // already spread over the lines in their proportions, so its share falls
  // on the lines the same way.
  const giftCards = order.lines
    .filter((l) => l.isGiftCard)
    .map((l) => l.originalUnitPrice * BigInt(l.quantity) - l.discountTotal);

  // An amount that is exactly one charge's whole amount is that charge's
  // refund: the gift card's or the
  // shipping's leaves the books alone, a book line's comes off that line.
  // Money only: units are never inferred from an amount.
  const candidates: { kind: "line" | "other"; index: number; amount: Minor }[] =
    [
      ...lines.map((l, index) => ({
        kind: "line" as const,
        index,
        amount: l.gross,
      })),
      ...giftCards.map((amount, index) => ({
        kind: "other" as const,
        index,
        amount,
      })),
      ...(order.shipping.amount > 0n
        ? [{ kind: "other" as const, index: -1, amount: order.shipping.amount }]
        : []),
    ];
  const matches = matchWholeCharges
    ? candidates.filter((c) => c.amount === refunded)
    : [];
  if (matches.length === 1) {
    const match = matches[0]!;
    if (match.kind === "other") {
      // Included shipping is spread over the lines in their proportions, so
      // its refund falls on them the same way; anything else leaves them.
      if (!(match.index === -1 && settings.includeShipping)) {
        return { lines: [...lines], netsClamped: 0, unplaced: 0n };
      }
    }
  }
  const single =
    matches.length === 1 && matches[0]!.kind === "line"
      ? matches[0]!.index
      : null;

  const others = [
    ...giftCards,
    ...(settings.includeShipping ? [] : [order.shipping.amount]),
  ].filter((w) => w > 0n);
  const all =
    single !== null
      ? lines.map((_, i) => (i === single ? -refunded : 0n))
      : allocateByMagnitude(
          -refunded,
          [...lines.map((l) => l.gross), ...others],
          [...lines.map((l) => l.quantity), ...others.map(() => 0)],
        );
  if (all === null) {
    return { lines: [...lines], netsClamped: 0, unplaced: refunded };
  }
  const shares = all.slice(0, lines.length);

  // Ex-tax and cash charged per real line, from the recorded tax (never a
  // rate): the effective line's own figures are on the order's basis and
  // carry no tax, so on a tax-exclusive order they cannot tell cash from
  // ex-tax.
  const real = new Map<string, { exTax: Minor; cash: Minor }>();
  const orderRatio = { exTax: 0n, cash: 0n };
  for (const l of order.lines) {
    if (l.isGiftCard) continue;
    const gross = l.originalUnitPrice * BigInt(l.quantity) - l.discountTotal;
    const exTax = removeTax(gross, l.tax, order.taxesIncluded);
    const cash = exTax + l.tax;
    real.set(l.id, { exTax, cash });
    orderRatio.exTax += exTax;
    orderRatio.cash += cash;
  }
  const exTax = lines.map((l, i) => {
    const share = shares[i]!;
    let lineEx = 0n;
    let lineCash = 0n;
    for (const id of l.sourceLineIds) {
      const r = real.get(id);
      if (r === undefined) continue;
      lineEx += r.exTax;
      lineCash += r.cash;
    }
    if (lineCash !== 0n) return mulDivRound(share, lineEx, lineCash);
    if (orderRatio.cash !== 0n) {
      return mulDivRound(share, orderRatio.exTax, orderRatio.cash);
    }
    return share;
  });

  // Shipping is left alone: the money was not refunded against shipping.
  const d = computeDeductions(
    exTax,
    // The adjustment is cash, tax included: it is the charge returned.
    shares,
    lines.map((l) => l.quantity),
    0n,
    order.fee,
    { ...settings, includeShipping: false },
    "refund",
  );

  return {
    lines: lines.map((l, i) => {
      // On the order's basis: cash on a tax-inclusive order, ex-tax on a
      // tax-exclusive one, as the line's own gross and discount are.
      const onBasis = order.taxesIncluded ? shares[i]! : exTax[i]!;
      const next = {
        ...l,
        gross: l.gross + onBasis,
        discount: l.discount - onBasis,
        exTax: l.exTax + exTax[i]!,
        commission: l.commission + d.commission[i]!,
        fees: l.fees + d.fees[i]!,
      };
      return {
        ...next,
        net: next.exTax - next.commission - next.fees + next.shipping,
      };
    }),
    netsClamped: d.netsClamped,
    unplaced: 0n,
  };
}
