// ISO 4217 minor-unit exponents.
//
// The exponent decides how a decimal string from the store becomes integer minor
// units, so a wrong entry silently scales every amount in that currency by a
// power of ten. An unknown code therefore throws rather than defaulting to 2:
// a loud failure on a rare currency beats a quietly wrong royalty.
//
// The order reader hands amounts over as decimal strings; parseDecimal accepts extra
// fractional zeros (e.g. "1200.0" for JPY), so a presentation that pads is
// harmless. No currency is recorded here as presenting a different exponent
// from ISO, because none could be verified; if one turns up, parseDecimal will
// throw on it rather than round, and this table is the place to note it.
//
// Recently withdrawn codes (HRK, SLL, ZWL, CUC, ANG, BGN, VEF) are kept so that
// historical orders inside the extraction window still parse.

const ZERO = [
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
] as const;

const THREE = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"] as const;

// Unidades de Fomento (CLF) and the Uruguayan wage index unit (UYW) are
// accounting units, unlikely on a shop, but ISO gives them 4 and guessing 2
// would be the silent 100× error this table exists to prevent.
const FOUR = ["CLF", "UYW"] as const;

const TWO = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BMD", "BND", "BOB", "BOV", "BRL", "BSD",
  "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CNY",
  "COP", "COU", "CRC", "CUC", "CUP", "CVE", "CZK", "DKK", "DOP", "DZD",
  "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP",
  "GMD", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR", "ILS",
  "INR", "IRR", "JMD", "KES", "KGS", "KHR", "KPW", "KYD", "KZT", "LAK",
  "LBP", "LKR", "LRD", "LSL", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT",
  "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD",
  "NGN", "NIO", "NOK", "NPR", "NZD", "PAB", "PEN", "PGK", "PHP", "PKR",
  "PLN", "QAR", "RON", "RSD", "RUB", "SAR", "SBD", "SCR", "SDG", "SEK",
  "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC", "SYP",
  "SZL", "THB", "TJS", "TMT", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH",
  "USD", "USN", "UYU", "UZS", "VED", "VEF", "VES", "WST", "XCD", "XCG",
  "YER", "ZAR", "ZMW", "ZWG", "ZWL",
] as const; // prettier-ignore

const EXPONENTS: ReadonlyMap<string, number> = new Map<string, number>([
  ...ZERO.map((c) => [c, 0] as const),
  ...TWO.map((c) => [c, 2] as const),
  ...THREE.map((c) => [c, 3] as const),
  ...FOUR.map((c) => [c, 4] as const),
]);

/**
 * Number of decimal places in the currency's minor unit (a count, not money).
 * Codes are case-sensitive: Medusa stores currency codes in lower case
 * ("gbp"), so the edge must upper-case them, and accepting "gbp" here would
 * hide an edge that forgot to.
 */
export function minorUnitExponent(currency: string): number {
  const exponent = EXPONENTS.get(currency);
  if (exponent === undefined) {
    throw new Error(
      `Unknown or non-monetary currency code: ${JSON.stringify(currency)}`,
    );
  }
  return exponent;
}

/** 10^exponent as a bigint: the number of minor units in one major unit. */
export function minorUnitsPerMajor(currency: string): bigint {
  return 10n ** BigInt(minorUnitExponent(currency));
}
