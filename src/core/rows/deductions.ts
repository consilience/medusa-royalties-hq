import { applyPercent, parsePercent, type Minor } from "../money";
import type { CoreOrder, CoreSettings } from "../types";
import { allocateByMagnitude, computeFees } from "./fees";

/** The settings the net calculation reads; the rest belong to other steps. */
export type NetSettings = Pick<
  CoreSettings,
  "commissionPercent" | "cardFeeMode" | "flatFeePercent" | "includeShipping"
>;

export interface Deductions {
  commission: Minor[];
  fees: Minor[];
  shipping: Minor[];
  /** Shipping with no line to carry it (e.g. a gift-card-only order). */
  unallocatedShipping: Minor;
  feeFallback: boolean;
  flatFeeMissing: boolean;
  /** Lines whose fee was cut back so the deductions could not flip the net's sign. */
  netsClamped: number;
}

/**
 * Commission, card fees and shipping share for a set of lines, shared by the
 * sale and refund paths so a refund goes through literally the same steps as
 * its sale. Signs follow `exTax`:
 * a refund passes non-positive amounts and gets non-positive deductions.
 */
export function computeDeductions(
  exTax: readonly Minor[],
  /** What the customer paid per line, tax included: the card fee's base. */
  charged: readonly Minor[],
  quantities: readonly number[],
  shippingExTax: Minor,
  fee: CoreOrder["fee"],
  settings: NetSettings,
  side: "sale" | "refund",
): Deductions {
  // Commission and fees are each a percentage of ex-tax, never compounded
  // Taking the fee from the post-commission amount would
  // make the result depend on which is applied first.
  let shipping = exTax.map(() => 0n);
  let unallocatedShipping = 0n;
  if (settings.includeShipping && shippingExTax !== 0n) {
    // Shipping is spread by ex-tax so dearer books carry
    // more of it; an all-zero order still has units to spread it over.
    const shares = allocateByMagnitude(shippingExTax, exTax, quantities);
    if (shares === null) {
      unallocatedShipping = shippingExTax;
    } else {
      shipping = shares;
    }
  }

  // Commission is on everything the line brings in, so on its shipping
  // share too when shipping is included.
  const commissionPct =
    settings.commissionPercent === null
      ? 0n
      : parsePercent(settings.commissionPercent);
  const commission = exTax.map((x, i) =>
    applyPercent(x + shipping[i]!, commissionPct),
  );

  const {
    fees: rawFees,
    feeFallback,
    flatFeeMissing,
  } = computeFees(charged, fee, settings);

  // A deduction may take a line to zero but never past it: a sale with a
  // negative royalty, or a refund with a positive one (which RHQ refuses),
  // would mean the author is charged for being sold. Settings validation
  // keeps commission + flat fee ≤ 100%, but an actual fee ratio is whatever
  // the processor charged, so commission + actual fee can still exceed the
  // line. Only the fee is cut back: commission is bounded by ex-tax on its
  // own, and the fee is the deduction that overshot. The sale and refund
  // paths clamp by the same rule mirrored, so a full refund still reverses
  // its sale exactly.
  let netsClamped = 0;
  const fees = rawFees.map((f, i) => {
    const net = exTax[i]! - commission[i]! - f + shipping[i]!;
    if (side === "sale" && net < 0n && f > 0n) {
      netsClamped += 1;
      return f + (net < -f ? -f : net);
    }
    if (side === "refund" && net > 0n && f < 0n) {
      netsClamped += 1;
      return f + (net > -f ? -f : net);
    }
    return f;
  });

  return {
    commission,
    fees,
    shipping,
    unallocatedShipping,
    feeFallback,
    flatFeeMissing,
    netsClamped,
  };
}

/**
 * Removes recorded tax where the amount includes it. On a
 * tax-exclusive order the amount never contained the tax, so subtracting it
 * would under-report. Recorded tax is used as-is, never recomputed from a
 * rate here, so the figure matches what the store charged to the penny.
 * (Medusa stores rates, not amounts; its reader supplies the tax Medusa's own
 * formula gives, which is what the customer was charged.)
 */
export function removeTax(
  amount: Minor,
  tax: Minor,
  taxesIncluded: boolean,
): Minor {
  return taxesIncluded ? amount - tax : amount;
}
