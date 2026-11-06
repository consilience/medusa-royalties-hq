import type { Minor } from "./types";

/**
 * Splits `total` across `weights` so the parts sum to `total` exactly and each
 * part is within one minor unit of its exact proportional share (Hamilton /
 * largest-remainder method).
 *
 * - Each part first gets floor(|total|·w / W); the units left over go one each
 *   to the largest remainders. Ties go to the lowest index so the same inputs
 *   always give the same rows and the same payload hash.
 * - A negative total is allocated as its absolute value and re-signed. Floor
 *   division towards −∞ would otherwise hand refunds a different rounding from
 *   the sale they reverse; this way a full refund exactly undoes the sale.
 * - A zero weight always gets zero: its remainder is zero, and the leftover
 *   count is strictly less than the number of non-zero remainders.
 * - All-zero (or no) weights throw. What to do then (even split, by quantity)
 *   is a business decision that belongs to the caller.
 */
export function allocateLargestRemainder(
  total: Minor,
  weights: readonly bigint[],
): Minor[] {
  let weightSum = 0n;
  for (const w of weights) {
    if (w < 0n) {
      throw new Error("allocateLargestRemainder: a weight is negative");
    }
    weightSum += w;
  }
  if (weightSum === 0n) {
    throw new Error("allocateLargestRemainder: weights are empty or all zero");
  }

  const negative = total < 0n;
  const magnitude = negative ? -total : total;

  const parts: bigint[] = [];
  const remainders: bigint[] = [];
  let allocated = 0n;
  for (const w of weights) {
    const product = magnitude * w;
    const part = product / weightSum;
    parts.push(part);
    remainders.push(product % weightSum);
    allocated += part;
  }

  // Leftover is a count of single minor units, bounded by weights.length.
  let leftover = magnitude - allocated;
  const order = weights
    .map((_, index) => index)
    .sort((a, b) => {
      const ra = remainders[a]!;
      const rb = remainders[b]!;
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a - b;
    });
  for (const index of order) {
    if (leftover === 0n) break;
    parts[index] = parts[index]! + 1n;
    leftover -= 1n;
  }

  return negative ? parts.map((p) => -p) : parts;
}
