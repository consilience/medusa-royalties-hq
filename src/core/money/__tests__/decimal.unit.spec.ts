import { formatDecimal, parseDecimal } from "../../money";
import { mulberry32, randBigInt, randInt } from "../../__tests__/support/prng";

describe("parseDecimal", () => {
  it.each([
    ["187.43", "GBP", 18743n],
    ["-13.39", "GBP", -1339n],
    ["0.05", "GBP", 5n],
    ["-0.05", "GBP", -5n],
    ["12", "GBP", 1200n],
    ["12.5", "GBP", 1250n],
    ["0", "GBP", 0n],
    ["-0", "GBP", 0n],
    ["1500", "JPY", 1500n],
    ["1200.0", "JPY", 1200n],
    ["1200.00", "JPY", 1200n],
    ["12.345", "KWD", 12345n],
    ["12.3", "KWD", 12300n],
    ["12.30", "GBP", 1230n],
    ["12.300", "GBP", 1230n],
    ["007.10", "GBP", 710n],
    // Far past 2^53: the whole point of bigint.
    ["123456789012345678.91", "USD", 12345678901234567891n],
  ])("parses %j %s to %s", (amount, currency, expected) => {
    expect(parseDecimal(amount, currency)).toBe(expected);
  });

  it.each([
    ["1.005", "GBP"],
    ["1200.5", "JPY"],
    ["1.2345", "KWD"],
  ])("refuses to round %j %s", (amount, currency) => {
    expect(() => parseDecimal(amount, currency)).toThrow(/decimal/i);
  });

  it.each([
    "",
    " 1.00",
    "1.00 ",
    "+1.00",
    "1,000.00",
    "1e3",
    "1.",
    ".5",
    "--1",
    "1.2.3",
    "NaN",
    "Infinity",
    "0x10",
    "١٢",
  ])("rejects malformed %j", (amount) => {
    expect(() => parseDecimal(amount, "GBP")).toThrow(/amount/i);
  });

  it("rejects an unknown currency", () => {
    expect(() => parseDecimal("1.00", "XXX")).toThrow(/currency/i);
  });
});

describe("formatDecimal", () => {
  it.each([
    [18743n, "GBP", "187.43"],
    [-1339n, "GBP", "-13.39"],
    [5n, "GBP", "0.05"],
    [-5n, "GBP", "-0.05"],
    [0n, "GBP", "0.00"],
    [1200n, "GBP", "12.00"],
    [1500n, "JPY", "1500"],
    [-1500n, "JPY", "-1500"],
    [0n, "JPY", "0"],
    [12345n, "KWD", "12.345"],
    [7n, "KWD", "0.007"],
    [-7n, "KWD", "-0.007"],
    [12345678901234567891n, "USD", "123456789012345678.91"],
  ])("formats %s %s as %j", (minor, currency, expected) => {
    expect(formatDecimal(minor, currency)).toBe(expected);
  });

  it("rejects an unknown currency", () => {
    expect(() => formatDecimal(1n, "XXX")).toThrow(/currency/i);
  });
});

describe("parse/format round trip", () => {
  it("format then parse is the identity for 5000 random amounts", () => {
    const rng = mulberry32(20260927);
    const currencies = ["JPY", "GBP", "KWD", "CLF"];
    for (let i = 0; i < 5000; i++) {
      const currency = currencies[randInt(rng, 0, currencies.length - 1)]!;
      const magnitude = randBigInt(rng, 22);
      const minor = rng() < 0.5 ? -magnitude : magnitude;
      const text = formatDecimal(minor, currency);
      expect(text).toMatch(/^-?\d+(\.\d+)?$/);
      expect(parseDecimal(text, currency)).toBe(minor);
    }
  });
});
