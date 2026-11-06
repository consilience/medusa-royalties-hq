import {
  applyPercent,
  mulDivRound,
  parsePercent,
  PERCENT_SCALE,
  ratio,
} from "../../money";
import { mulberry32, randBigInt } from "../../__tests__/support/prng";

describe("parsePercent", () => {
  it("uses a scale of 10^4", () => {
    expect(PERCENT_SCALE).toBe(10_000n);
  });

  it.each([
    ["15", 150_000n],
    ["12.5", 125_000n],
    ["8.5000", 85_000n],
    ["0", 0n],
    ["0.0001", 1n],
    ["100", 1_000_000n],
    ["100.0000", 1_000_000n],
    ["2.90", 29_000n],
    ["8.50000", 85_000n],
  ])("parses %j to %s", (text, expected) => {
    expect(parsePercent(text)).toBe(expected);
  });

  it.each(["100.0001", "101", "-1", "-0.5"])(
    "rejects out-of-range %j",
    (text) => {
      expect(() => parsePercent(text)).toThrow(/percent/i);
    },
  );

  it.each(["", "15%", " 15", "+15", "1e1", "15.", ".5", "12,5", "0.00001"])(
    "rejects malformed or over-precise %j",
    (text) => {
      expect(() => parsePercent(text)).toThrow(/percent/i);
    },
  );
});

describe("mulDivRound", () => {
  it.each([
    [10n, 1n, 4n, 3n], // 2.5 → 3
    [-10n, 1n, 4n, -3n], // −2.5 → −3 (away from zero)
    [10n, -1n, 4n, -3n],
    [10n, 1n, -4n, -3n],
    [-10n, -1n, 4n, 3n],
    [9n, 1n, 4n, 2n], // 2.25 → 2
    [-9n, 1n, 4n, -2n],
    [11n, 1n, 4n, 3n], // 2.75 → 3
    [0n, 5n, 7n, 0n],
    [7n, 3n, 1n, 21n],
  ])("%s × %s ÷ %s = %s", (a, b, c, expected) => {
    expect(mulDivRound(a, b, c)).toBe(expected);
  });

  it("throws on a zero divisor", () => {
    expect(() => mulDivRound(1n, 1n, 0n)).toThrow(/zero/i);
  });

  it("is odd-symmetric: f(−a) = −f(a) (property)", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 2000; i++) {
      const a = randBigInt(rng, 15);
      const b = randBigInt(rng, 8);
      const c = randBigInt(rng, 10) + 1n;
      const r = mulDivRound(a, b, c);
      expect(mulDivRound(-a, b, c)).toBe(-r);
      // Within half a unit of the exact value: |r·c − a·b| ≤ c/2.
      const diff = r * c - a * b;
      expect(2n * (diff < 0n ? -diff : diff) <= c).toBe(true);
    }
  });
});

describe("applyPercent", () => {
  it.each([
    [10000n, "15", 1500n],
    [999n, "15", 150n], // 149.85 → 150
    [-999n, "15", -150n], // refund mirrors the sale
    [10n, "25", 3n], // 2.5 → 3
    [-10n, "25", -3n], // −2.5 → −3, not −2
    [1234n, "12.5", 154n], // 154.25 → 154
    [18743n, "2.9", 544n], // 543.547 → 544
    [100n, "0", 0n],
    [100n, "100", 100n],
    [3n, "0.0001", 0n],
  ])("%s at %s%% = %s", (amount, pct, expected) => {
    expect(applyPercent(amount, parsePercent(pct))).toBe(expected);
  });
});

describe("ratio", () => {
  it.each([
    [1n, 8n, 4, "12.5000"],
    [1n, 3n, 4, "33.3333"],
    [2n, 3n, 4, "66.6667"],
    [0n, 5n, 4, "0.0000"],
    [5n, 5n, 4, "100.0000"],
    [-1n, 3n, 4, "-33.3333"],
    [1n, 3n, 2, "33.33"],
    [1n, 3n, 0, "33"],
    [1n, 8n, 0, "13"], // 12.5 → 13 (half-up)
    [1n, 200_000_000n, 4, "0.0000"], // 0.0000005 → 0.0000 (below half)
    [1n, 2_000_000n, 4, "0.0001"], // 0.00005 → 0.0001 (exact half)
    [-1n, 2_000_000n, 4, "-0.0001"],
    [-1n, 200_000_000n, 4, "0.0000"], // rounds to zero: no "-0.0000"
  ])("%s / %s at %s dp = %j", (n, d, digits, expected) => {
    expect(ratio(n, d, digits)).toBe(expected);
  });

  it("throws on a zero denominator", () => {
    expect(() => ratio(1n, 0n, 4)).toThrow(/zero/i);
  });

  it.each([-1, 1.5])("rejects digits %s", (digits) => {
    expect(() => ratio(1n, 3n, digits)).toThrow(/digits/i);
  });
});
