import { allocateLargestRemainder, mulDivRound, type Minor } from "../money";
import type { BundleFallback } from "../types";
import type { BundleFallbackReason } from "./types";

export interface Weighting {
  method: BundleFallback;
  /**
   * Weight per unit of each component. A component's weight in a split is
   * unit weight × its quantity: sold quantity for the sale, refunded quantity
   * for a refund, so a refund re-uses the sale's ratio.
   */
  unitWeights: bigint[];
  /** Set when price_ratio could not be honoured and quantity was used. */
  reason: BundleFallbackReason | null;
}

/**
 * Unit weights for a re-weighted split.
 *
 * `price_ratio` weighs by regular unit price. A component with no known
 * price makes the whole bundle fall back to quantity: weighing it at zero
 * would quietly hand its author nothing, and guessing a price would be worse.
 * All-zero prices also fall back to quantity, since there is nothing to weigh
 * by. `even` is quantity by definition (unit weight 1).
 */
export function chooseWeights(
  prices: readonly (Minor | null)[],
  method: BundleFallback,
): Weighting {
  const byQuantity = prices.map(() => 1n);
  if (method === "even") {
    return { method: "even", unitWeights: byQuantity, reason: null };
  }
  const known: Minor[] = [];
  for (const p of prices) {
    if (p === null) {
      return {
        method: "even",
        unitWeights: byQuantity,
        reason: "price_unknown",
      };
    }
    // A negative catalog price is a data error; weighing by it would make
    // allocateLargestRemainder throw, so treat it as unknown instead.
    if (p < 0n) {
      return {
        method: "even",
        unitWeights: byQuantity,
        reason: "price_unknown",
      };
    }
    known.push(p);
  }
  if (!known.some((p) => p > 0n)) {
    return {
      method: "even",
      unitWeights: byQuantity,
      reason: "prices_all_zero",
    };
  }
  return { method: "price_ratio", unitWeights: known, reason: null };
}

/** unit weight × quantity per component, as bigint weights. */
export function scaleWeights(
  unitWeights: readonly bigint[],
  quantities: readonly number[],
): bigint[] {
  return unitWeights.map((w, i) => w * BigInt(quantities[i]!));
}

/**
 * Splits every money field of `pool` by the same weights, each field with
 * largest remainder, so each field's parts sum exactly to the pooled field.
 *
 * Fields are split independently rather than splitting net and deriving the
 * rest: exTax, commission, fees and shipping each land in their own RHQ
 * breakdown column, so each must reconcile to the order on its own.
 */
export function splitPool<K extends string>(
  pool: Record<K, Minor>,
  keys: readonly K[],
  weights: readonly bigint[],
): Record<K, Minor>[] {
  const perKey = keys.map((k) => allocateLargestRemainder(pool[k], weights));
  return weights.map((_, i) => {
    const part = {} as Record<K, Minor>;
    keys.forEach((k, j) => {
      part[k] = perKey[j]![i]!;
    });
    return part;
  });
}

/** Sums the given money fields over a set of records. */
export function poolOf<K extends string>(
  items: readonly Record<K, Minor>[],
  keys: readonly K[],
): Record<K, Minor> {
  const pool = {} as Record<K, Minor>;
  for (const k of keys) pool[k] = 0n;
  for (const it of items) for (const k of keys) pool[k] = pool[k] + it[k];
  return pool;
}

/**
 * Regular unit price ex tax. On a tax-inclusive order the
 * price is scaled by the source's exTax ÷ gross, i.e. by the tax actually
 * recorded, never by a rate we would have to guess.
 *
 * A source with zero gross (a free copy, a bundle given away) records no tax
 * and so has no ratio of its own. Returning null there dropped the free units
 * from discount_percent, so a 2-for-1 read as no discount at all. Instead the
 * order's Σ exTax ÷ Σ gross stands in, as it does for the breakdown's
 * discount (tax on one order is normally charged at one rate). If the whole
 * order is free there is no tax information anywhere; nothing was charged, so
 * the tax is taken as zero and the price used as is.
 */
export function listPriceExTax(
  price: Minor | null,
  exTax: Minor,
  gross: Minor,
  taxesIncluded: boolean,
  orderRatio: { exTax: Minor; gross: Minor },
): Minor | null {
  if (price === null) return null;
  if (!taxesIncluded) return price;
  if (gross !== 0n) return mulDivRound(price, exTax, gross);
  if (orderRatio.gross !== 0n) {
    return mulDivRound(price, orderRatio.exTax, orderRatio.gross);
  }
  return price;
}

/**
 * The first weight set with a non-zero sum. allocateLargestRemainder refuses
 * all-zero weights (what to do then is a business decision), so callers list
 * their preferred weights first and the fallbacks after, in order.
 */
export function firstUsable(...candidates: bigint[][]): bigint[] {
  for (const c of candidates) {
    if (c.some((w) => w > 0n)) return c;
  }
  // Last resort, reachable only when every candidate is empty or zero:
  // an even split keeps the totals exact rather than throwing mid-order.
  const n = candidates[0]?.length ?? 0;
  return Array.from({ length: n }, () => 1n);
}
