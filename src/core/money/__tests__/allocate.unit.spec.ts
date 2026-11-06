import { allocateLargestRemainder } from "../../money";
import { mulberry32, randBigInt, randInt } from "../../__tests__/support/prng";

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe("allocateLargestRemainder", () => {
  it("splits evenly when it divides", () => {
    expect(allocateLargestRemainder(300n, [1n, 1n, 1n])).toEqual([
      100n,
      100n,
      100n,
    ]);
  });

  it("gives leftover units to the largest remainders", () => {
    // Exact shares 33.33.., 66.66..: remainders favour the second.
    expect(allocateLargestRemainder(100n, [1n, 2n])).toEqual([33n, 67n]);
  });

  it("breaks ties by lowest index", () => {
    expect(allocateLargestRemainder(100n, [1n, 1n, 1n])).toEqual([
      34n,
      33n,
      33n,
    ]);
    expect(allocateLargestRemainder(2n, [1n, 1n, 1n])).toEqual([1n, 1n, 0n]);
  });

  it("mirrors negative totals exactly", () => {
    expect(allocateLargestRemainder(-100n, [1n, 1n, 1n])).toEqual([
      -34n,
      -33n,
      -33n,
    ]);
    expect(allocateLargestRemainder(-100n, [1n, 2n])).toEqual([-33n, -67n]);
  });

  it("gives zero weights zero, even with leftovers", () => {
    expect(allocateLargestRemainder(10n, [0n, 1n, 0n, 2n])).toEqual([
      0n,
      3n,
      0n,
      7n,
    ]);
  });

  it("allocates a zero total as zeros", () => {
    expect(allocateLargestRemainder(0n, [3n, 5n])).toEqual([0n, 0n]);
  });

  it("returns the whole total for a single weight", () => {
    expect(allocateLargestRemainder(-987n, [42n])).toEqual([-987n]);
  });

  it("throws when all weights are zero", () => {
    expect(() => allocateLargestRemainder(100n, [0n, 0n])).toThrow(/weight/i);
  });

  it("throws on no weights", () => {
    expect(() => allocateLargestRemainder(100n, [])).toThrow(/weight/i);
  });

  it("throws on a negative weight", () => {
    expect(() => allocateLargestRemainder(100n, [2n, -1n])).toThrow(/weight/i);
  });

  it("preserves the sum and stays within 1 of the exact share (property)", () => {
    const rng = mulberry32(4217);
    for (let i = 0; i < 3000; i++) {
      const n = randInt(rng, 1, 12);
      const weights: bigint[] = Array.from({ length: n }, () =>
        rng() < 0.2 ? 0n : randBigInt(rng, randInt(rng, 1, 8)),
      );
      // `some` rather than `every(w => w === 0n)`: TS 5.5 infers the latter as
      // a type predicate and narrows the array to 0n[].
      if (!weights.some((w) => w !== 0n)) weights[0] = 1n;
      const magnitude = randBigInt(rng, randInt(rng, 1, 20));
      const total = rng() < 0.4 ? -magnitude : magnitude;

      const parts = allocateLargestRemainder(total, weights);
      const totalWeight = sum(weights);

      expect(parts).toHaveLength(n);
      expect(sum(parts)).toBe(total);
      parts.forEach((part, k) => {
        const w = weights[k]!;
        if (w === 0n) expect(part).toBe(0n);
        // |part − total·w/W| < 1  ⇔  |part·W − total·w| < W, kept in integers.
        const diff = part * totalWeight - total * w;
        expect(diff < 0n ? -diff : diff).toBeLessThan(totalWeight);
        // Sign follows the total: a refund never produces a positive part.
        if (total < 0n) expect(part <= 0n).toBe(true);
        if (total > 0n) expect(part >= 0n).toBe(true);
      });

      // Mirror symmetry: refunds must exactly undo sales.
      expect(allocateLargestRemainder(-total, weights)).toEqual(
        parts.map((p) => -p),
      );
    }
  });
});
