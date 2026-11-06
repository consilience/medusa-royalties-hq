import { formatFixed, parseFixed } from "./decimal";
import type { Minor, ScaledPercent } from "./types";

/**
 * Percentages are held as bigints scaled by 10^4 (hundredths of a basis point),
 * so settings such as "12.5" or "8.5000" are exact and no float ever touches a
 * commission or fee.
 */
export const PERCENT_SCALE = 10_000n;
const PERCENT_DIGITS = 4;
const HUNDRED_PERCENT = 100n * PERCENT_SCALE;

/** "15" → 150_000n, "12.5" → 125_000n. 0–100 inclusive, up to 4 dp. */
export function parsePercent(text: string): ScaledPercent {
  let scaled: bigint;
  try {
    scaled = parseFixed(text, PERCENT_DIGITS, "percent");
  } catch (error) {
    throw new Error(
      `Invalid percent ${JSON.stringify(text)}: ${(error as Error).message}`,
    );
  }
  // A negative commission or a fee above 100% is a settings error, not a
  // value to carry into row maths.
  if (text.startsWith("-") || scaled > HUNDRED_PERCENT) {
    throw new Error(`Percent out of range 0–100: ${JSON.stringify(text)}`);
  }
  return scaled;
}

/**
 * round(a × b ÷ c), exact, with halves rounded away from zero.
 *
 * Away from zero rather than towards +∞ because refunds are negative amounts
 * that must mirror their sales exactly: a 2.5p commission on a sale rounds to
 * 3p, so on the matching refund it must round to −3p. Half-up in the "towards
 * +∞" sense would give −2p and leave 1p of commission behind for every such
 * refund. Also used for fee ratios (fee ÷ charge applied to an amount).
 */
export function mulDivRound(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) {
    throw new Error("mulDivRound: division by zero");
  }
  const numerator = a * b;
  const negative = numerator < 0n !== c < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = c < 0n ? -c : c;
  let q = n / d;
  if (2n * (n % d) >= d) q += 1n;
  // q is 0n when the result rounds to zero, and -0n === 0n, so no "negative
  // zero" can leak out.
  return negative ? -q : q;
}

/** amount × pct%, rounded half away from zero (see mulDivRound). */
export function applyPercent(amount: Minor, pct: ScaledPercent): Minor {
  return mulDivRound(amount, pct, HUNDRED_PERCENT);
}

/**
 * numerator ÷ denominator as a percent string with exactly `digits` decimals,
 * rounded half away from zero, e.g. ratio(1n, 8n, 4) → "12.5000". Used for
 * `discount_percent` (4 dp), where the API expects a fixed-precision string.
 */
export function ratio(
  numerator: bigint,
  denominator: bigint,
  digits: number,
): string {
  if (!Number.isInteger(digits) || digits < 0) {
    throw new Error(
      `ratio: digits must be a non-negative integer, got ${digits}`,
    );
  }
  if (denominator === 0n) {
    throw new Error("ratio: division by zero");
  }
  const scaled = mulDivRound(
    numerator,
    100n * 10n ** BigInt(digits),
    denominator,
  );
  return formatFixed(scaled, digits);
}
