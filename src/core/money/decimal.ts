import { minorUnitExponent } from "./currency";
import type { Minor } from "./types";

// Deliberately narrow: the order reader rounds Medusa's raw values to the
// currency exponent and hands over a plain string like "187.43" or "-13.39". Anything else (exponents, thousands separators, a
// leading "+", whitespace) means the edge handed over something it should not
// have, and guessing at it is how money bugs start.
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses a plain decimal string to an integer scaled by 10^digits.
 * Extra fractional digits are tolerated only when they are zeros, so no value
 * is ever rounded on the way in: a genuinely finer amount throws.
 */
export function parseFixed(
  amount: string,
  digits: number,
  label = "amount",
): bigint {
  const match = DECIMAL.exec(amount);
  if (!match) {
    throw new Error(`Malformed ${label}: ${JSON.stringify(amount)}`);
  }
  const [, sign, whole = "", fraction = ""] = match;
  const kept = fraction.slice(0, digits);
  const dropped = fraction.slice(digits);
  if (/[^0]/.test(dropped)) {
    throw new Error(
      `Decimal ${JSON.stringify(amount)} has more than ${digits} significant fractional digits; refusing to round`,
    );
  }
  const magnitude = BigInt(whole + kept.padEnd(digits, "0"));
  // -0 has no bigint representation, so "-0.00" naturally becomes 0n.
  return sign === "-" ? -magnitude : magnitude;
}

/** Formats an integer scaled by 10^digits with exactly `digits` decimals. */
export function formatFixed(value: bigint, digits: number): string {
  const negative = value < 0n;
  const magnitude = (negative ? -value : value).toString();
  if (digits === 0) {
    return (negative ? "-" : "") + magnitude;
  }
  const padded = magnitude.padStart(digits + 1, "0");
  const whole = padded.slice(0, padded.length - digits);
  const fraction = padded.slice(padded.length - digits);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** "187.43" GBP → 18743n. Throws on malformed input or on sub-minor precision. */
export function parseDecimal(amount: string, currency: string): Minor {
  // Resolve the exponent first so an unknown currency is reported as such,
  // not as a malformed amount.
  const exponent = minorUnitExponent(currency);
  return parseFixed(amount, exponent);
}

/**
 * 18743n GBP → "187.43"; always the currency's exponent digits, because the
 * RHQ API and CSV consumers compare these strings, and "187.4" vs "187.40"
 * would change the payload hash for no reason.
 */
export function formatDecimal(minor: Minor, currency: string): string {
  return formatFixed(minor, minorUnitExponent(currency));
}
