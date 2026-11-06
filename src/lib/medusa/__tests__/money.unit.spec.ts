import { PRECISION, rawToScaled, roundToMinor, toMinor } from "../money"

describe("rawToScaled", () => {
  it("reads Medusa's raw {value, precision} objects and plain decimal strings exactly", () => {
    expect(rawToScaled({ value: "26.99999999999999975", precision: 20 })).toBe(2699999999999999975n * 10n ** 3n)
    expect(rawToScaled("12")).toBe(12n * 10n ** BigInt(PRECISION))
    expect(rawToScaled({ value: "-2.7272727272727275" })).toBe(-27272727272727275n * 10n ** 4n)
  })

  it("reads exponent notation, which BigNumber writes for very small or large values", () => {
    expect(rawToScaled({ value: "1e-7" })).toBe(10n ** BigInt(PRECISION - 7))
    expect(rawToScaled({ value: "2.5E+3" })).toBe(2500n * 10n ** BigInt(PRECISION))
  })

  it("refuses anything that is not a number, rather than guessing", () => {
    for (const bad of ["", "abc", "1,000.00", "NaN", "Infinity", null, undefined, 12.5]) {
      expect(() => rawToScaled(bad as never)).toThrow()
    }
  })

  it("refuses more fractional digits than Medusa's precision, so nothing is silently cut", () => {
    expect(() => rawToScaled({ value: "0." + "1".repeat(PRECISION + 1) })).toThrow()
  })
})

describe("roundToMinor", () => {
  it("rounds half away from zero to the currency exponent, never truncating", () => {
    expect(roundToMinor(rawToScaled("26.99999999999999975"), "USD")).toBe(2700n)
    expect(roundToMinor(rawToScaled("2.725"), "GBP")).toBe(273n)
    expect(roundToMinor(rawToScaled("2.7249999"), "GBP")).toBe(272n)
    expect(roundToMinor(rawToScaled("-2.725"), "GBP")).toBe(-273n)
  })

  it("uses each currency's own exponent", () => {
    expect(roundToMinor(rawToScaled("1500.5"), "JPY")).toBe(1501n)
    expect(roundToMinor(rawToScaled("1.2345"), "KWD")).toBe(1235n)
  })
})

describe("toMinor", () => {
  it("is rawToScaled then roundToMinor", () => {
    expect(toMinor({ value: "36.99999999999999975" }, "USD")).toBe(3700n)
  })
})
