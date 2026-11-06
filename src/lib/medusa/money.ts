import { minorUnitExponent, type Minor } from "../../core/money"

// Medusa hands order amounts back as BigNumber objects with a raw sibling,
// `raw_total: { value: "26.99999999999999975", precision: 20 }`, and payment
// amounts as JS numbers with `raw_amount`. The raw strings are not
// exact to the cent: Medusa computes totals from rates and spreads, so a
// $27.00 line can read 26.99999999999999975. So every amount is read from
// its raw string into an integer scaled by 10^20 (no float ever), arithmetic
// that has to happen before rounding happens at that scale, and each amount
// is rounded exactly once to the currency's minor unit, half away from zero
// (bignumber.js's ROUND_HALF_UP, which Medusa itself uses). Truncating would
// turn 26.99999999999999975 into 26.99.

/** Medusa's BigNumber precision. */
export const PRECISION = 20
const SCALE = 10n ** BigInt(PRECISION)

export type RawAmount = { value: string; precision?: number } | string

// Plain decimals and the exponent notation bignumber.js writes for very small
// or very large values. Nothing else: a number that needs guessing at is a
// bug upstream.
const NUMERIC = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

/** A raw Medusa amount as an integer scaled by 10^20. */
export function rawToScaled(raw: RawAmount): bigint {
  const text = typeof raw === "string" ? raw : raw && typeof raw === "object" ? raw.value : undefined
  if (typeof text !== "string") throw new Error(`Not a raw amount: ${JSON.stringify(raw)}`)
  const match = NUMERIC.exec(text.trim())
  if (!match) throw new Error(`Not a raw amount: ${JSON.stringify(text)}`)
  const [, sign, whole, fraction = "", exp = "0"] = match
  // Shift the decimal point by the exponent on the digit string itself.
  const digits = whole + fraction
  const point = whole.length + parseExponent(exp)
  const intPart = point <= 0 ? "0" : digits.slice(0, point).padEnd(point, "0")
  const fracPart = point <= 0 ? "0".repeat(-point) + digits : digits.slice(point)
  if (/[^0]/.test(fracPart.slice(PRECISION))) {
    throw new Error(`Raw amount ${JSON.stringify(text)} is finer than ${PRECISION} decimals; refusing to cut it`)
  }
  const magnitude = BigInt(intPart) * SCALE + BigInt(fracPart.slice(0, PRECISION).padEnd(PRECISION, "0") || "0")
  return sign === "-" ? -magnitude : magnitude
}

// The exponent is a short digit string from a regex group; read by hand
// because the money code never goes through Number().
function parseExponent(text: string): number {
  const negative = text.startsWith("-")
  const body = text.replace(/^[+-]/, "")
  let value = 0
  for (const ch of body) {
    value = value * 10 + (ch.charCodeAt(0) - 48)
    if (value > 400) throw new Error(`Raw amount exponent out of range: ${text}`)
  }
  return negative ? -value : value
}

/** A 10^20-scaled amount rounded half away from zero to the currency's minor unit. */
export function roundToMinor(scaled: bigint, currency: string): Minor {
  const divisor = 10n ** BigInt(PRECISION - minorUnitExponent(currency))
  const negative = scaled < 0n
  const magnitude = negative ? -scaled : scaled
  const quotient = magnitude / divisor
  const remainder = magnitude % divisor
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

export function toMinor(raw: RawAmount, currency: string): Minor {
  return roundToMinor(rawToScaled(raw), currency)
}
