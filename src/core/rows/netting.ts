import type { EffectiveLine, EffectiveRefundLine } from "../bundles";
import { mulDivRound, type Minor } from "../money";
import { allocateByMagnitude } from "./fees";

// Refunds made on or before the sale month's cut-off.
// Such a refund is not a refund: it lowers the
// sale it belongs to, so the month sends fewer units and less money and no
// units_refunded. A fully refunded order sends nothing.

const MONEY = ["gross", "exTax", "commission", "fees", "shipping"] as const;
type MoneyField = (typeof MONEY)[number];

const sameLine = (
  sale: EffectiveLine,
  refund: Pick<EffectiveRefundLine, "lineId" | "variantId">,
) => sale.lineId === refund.lineId && sale.variantId === refund.variantId;

const netOf = (l: Pick<EffectiveLine, MoneyField>) =>
  l.exTax - l.commission - l.fees + l.shipping;

/**
 * Nets refund lines into the order's sale lines. A refund line takes its
 * units and every figure (gross, ex tax, commission, fees, shipping) off
 * the sale line it names; refunds come in already through the same
 * deduction steps, so the sale's net falls by exactly the refund's net.
 *
 * A refund larger than its line leaves that line at zero and
 * takes the excess off the order's other sale lines, pro rata to what they
 * still net, largest remainder per figure. Excess with no other line to
 * carry it stays on its line.
 *
 * A refund line that matches no sale line (it cannot, for a refund of this
 * order, unless the ledger is inconsistent) is returned to be sent as a
 * refund, as before.
 */
export function netRefundsIntoSale(
  saleLines: readonly EffectiveLine[],
  refundLines: readonly EffectiveRefundLine[],
): { lines: EffectiveLine[]; unmatched: EffectiveRefundLine[] } {
  const lines = saleLines.map((l) => ({ ...l }));
  const unmatched: EffectiveRefundLine[] = [];
  for (const r of refundLines) {
    const target = lines.find((l) => sameLine(l, r));
    if (target === undefined) {
      unmatched.push(r);
      continue;
    }
    // The discount goes back with the units it was given on, so the netted
    // line's breakdown still reads gross − discount = what it sold for.
    if (target.quantity > 0 && r.units > 0) {
      const returned = r.units > target.quantity ? target.quantity : r.units;
      target.discount -= mulDivRound(
        target.discount,
        BigInt(returned),
        BigInt(target.quantity),
      );
    }
    // Units are counts; a refund of more units than were sold leaves none.
    const units = target.quantity - r.units;
    target.quantity = units < 0 ? 0 : units;
    for (const f of MONEY) target[f] += r[f];
    target.net = netOf(target);
  }

  for (const over of lines) {
    if (over.net >= 0n) continue;
    const others = lines.filter((l) => l !== over && l.net > 0n);
    if (others.length === 0) continue;
    const weights = others.map((l) => l.net);
    for (const f of MONEY) {
      const shares = allocateByMagnitude(over[f], weights, null);
      if (shares === null) continue;
      others.forEach((l, i) => {
        l[f] += shares[i]!;
      });
      over[f] = 0n;
    }
    for (const l of others) l.net = netOf(l);
    over.net = 0n;
  }
  return { lines, unmatched };
}

/** A sale line nothing is left of: no units and no money. */
export function isEmptied(l: EffectiveLine): boolean {
  return (
    l.quantity === 0 &&
    MONEY.every((f) => l[f] === (0n as Minor)) &&
    l.discount === 0n &&
    l.net === 0n
  );
}
