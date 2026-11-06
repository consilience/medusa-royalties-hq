import { minorUnitExponent } from "../../money";

describe("minorUnitExponent", () => {
  it.each([
    "JPY",
    "KRW",
    "VND",
    "ISK",
    "CLP",
    "UGX",
    "XAF",
    "XOF",
    "XPF",
    "PYG",
  ])("%s has 0 decimals", (c) => expect(minorUnitExponent(c)).toBe(0));

  it.each(["KWD", "BHD", "JOD", "OMR", "TND", "LYD", "IQD"])(
    "%s has 3 decimals",
    (c) => expect(minorUnitExponent(c)).toBe(3),
  );

  it.each(["GBP", "USD", "EUR", "AUD", "NZD", "CAD", "DKK", "INR"])(
    "%s has 2 decimals",
    (c) => expect(minorUnitExponent(c)).toBe(2),
  );

  it.each(["CLF", "UYW"])("%s has 4 decimals", (c) =>
    expect(minorUnitExponent(c)).toBe(4),
  );

  it.each(["XXX", "gbp", "", "GB", "XAU", "BTC"])(
    "throws for unknown or non-monetary code %j",
    (c) => expect(() => minorUnitExponent(c)).toThrow(/currency/i),
  );
});
