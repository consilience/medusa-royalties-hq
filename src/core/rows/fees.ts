import {
  allocateLargestRemainder,
  applyPercent,
  mulDivRound,
  parsePercent,
  type Minor,
} from "../money";
import type { CoreOrder, CoreSettings } from "../types";

export type FeeSettings = Pick<CoreSettings, "cardFeeMode" | "flatFeePercent">;

export interface FeeResult {
  /** One fee per input line, same sign as that line's ex-tax. */
  fees: Minor[];
  /** Actual mode, but the order's fee was unknown: flat % used instead (summary.fee_fallback_orders). */
  feeFallback: boolean;
  /** A flat % was needed (flat mode, or the fallback) but none is set: 0 deducted. */
  flatFeeMissing: boolean;
}

/**
 * Card fees for the lines of one order or one refund. `charged`
 * holds what the customer paid for each line, its tax included: positive
 * for a sale, negative for a refund, and the fees come back with the same
 * sign so a refund's fee reverses the sale's.
 *
 * On the charge, tax included, because that is what the processor takes its
 * fee on: a fee on ex-tax would deduct less than the store actually paid.
 * Commission stays on ex-tax.
 */
export function computeFees(
  charged: readonly Minor[],
  fee: CoreOrder["fee"],
  settings: FeeSettings,
): FeeResult {
  const zeros = charged.map(() => 0n);

  if (settings.cardFeeMode === "none") {
    return { fees: zeros, feeFallback: false, flatFeeMissing: false };
  }

  if (settings.cardFeeMode === "actual") {
    // A zero or negative charge makes the ratio meaningless, and a negative
    // fee would add money to the author; both are treated as "fee unknown"
    // so the order is flagged rather than silently mis-deducted.
    if (fee !== null && fee.charge > 0n && fee.fee >= 0n) {
      return {
        fees: actualFees(charged, fee.fee, fee.charge),
        feeFallback: false,
        flatFeeMissing: false,
      };
    }
    const flat = flatFees(charged, settings.flatFeePercent);
    return { ...flat, feeFallback: true };
  }

  return { ...flatFees(charged, settings.flatFeePercent), feeFallback: false };
}

function flatFees(
  charged: readonly Minor[],
  percent: string | null,
): Omit<FeeResult, "feeFallback"> {
  // Settings validation requires a percent in flat mode, but actual mode's
  // fallback can legitimately arrive here without one. Deducting nothing and
  // flagging it is the least wrong outcome: it over-reports to the author
  // (recoverable) rather than inventing a rate.
  if (percent === null) {
    return { fees: charged.map(() => 0n), flatFeeMissing: true };
  }
  const pct = parsePercent(percent);
  // Per line, rounded per line: the same rounding a refund of that line gets,
  // so a full refund mirrors the sale exactly.
  return {
    fees: charged.map((x) => applyPercent(x, pct)),
    flatFeeMissing: false,
  };
}

function actualFees(
  charged: readonly Minor[],
  fee: Minor,
  charge: Minor,
): Minor[] {
  // The fee is in the settlement currency and the order in the presentment
  // currency; converting the fee would need an FX rate we do not have and
  // would drift from the payout. As a ratio (fee ÷ charge, both settlement)
  // it is currency-free and can be applied to the sale-currency total.
  //
  // Computed once on the total and then split, rather than per line, so the
  // lines sum to exactly the rounded order fee. mulDivRound rounds half away
  // from zero, so a refund's negated total is exactly minus the sale's.
  const total = charged.reduce((a, b) => a + b, 0n);
  const orderFee = mulDivRound(total, fee, charge);
  return allocateByMagnitude(orderFee, charged, null) ?? charged.map(() => 0n);
}

/**
 * Splits `amount` over lines weighted by the magnitude of each line's ex-tax,
 * falling back to `quantities` when every ex-tax is zero. Returns null when
 * there is nothing to weigh by (no lines, or all weights zero), leaving the
 * caller to decide what that means.
 *
 * Magnitudes rather than signed values because allocateLargestRemainder takes
 * non-negative weights, and a refund's lines are all ≤ 0; using |exTax| gives
 * a refund the very same weights, and so the same split, as its sale.
 */
export function allocateByMagnitude(
  amount: Minor,
  exTax: readonly Minor[],
  quantities: readonly number[] | null,
): Minor[] | null {
  const weights = exTax.map((x) => (x < 0n ? -x : x));
  if (weights.some((w) => w > 0n)) {
    return allocateLargestRemainder(amount, weights);
  }
  if (quantities !== null) {
    // Counts, converted once to bigint weights; BigInt of an integer count is
    // exact.
    const byQuantity = quantities.map((q) => BigInt(q < 0 ? -q : q));
    if (byQuantity.some((w) => w > 0n)) {
      return allocateLargestRemainder(amount, byQuantity);
    }
  }
  return null;
}
