import {
  computeLineNets,
  type LineNet,
} from "../../rows/lineNet";
import { line, order, settings } from "../../__tests__/support/builders";

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

// The one identity every line must satisfy, whatever the settings.
function expectNetIdentity(l: LineNet) {
  expect(l.net).toBe(l.exTax - l.commission - l.fees + l.shipping);
}

describe("computeLineNets: gross and tax", () => {
  it("removes recorded tax from a tax-inclusive line (GB VAT 20%)", () => {
    // £12.00 including £2.00 VAT.
    const l = line({ originalUnitPrice: 1200n, tax: 200n });
    const result = computeLineNets(
      order({ taxesIncluded: true, lines: [l] }),
      settings(),
    );
    expect(result.lines).toEqual([
      {
        lineId: l.id,
        gross: 1200n,
        discount: 0n,
        exTax: 1000n,
        commission: 0n,
        fees: 0n,
        shipping: 0n,
        net: 1000n,
      },
    ]);
  });

  it("does not subtract tax from a tax-exclusive line (US)", () => {
    // $10.00 plus $0.80 sales tax on top: the line amount never contained it.
    const l = line({ originalUnitPrice: 1000n, tax: 80n });
    const [result] = computeLineNets(
      order({ currency: "USD", taxesIncluded: false, lines: [l] }),
      settings(),
    ).lines;
    expect(result).toMatchObject({ gross: 1000n, exTax: 1000n, net: 1000n });
  });

  it("applies line- and order-level discounts allocated to each line", () => {
    // The platform has already spread a £2.00 order discount across both lines;
    // the core takes discountTotal as given.
    const a = line({
      originalUnitPrice: 500n,
      quantity: 2,
      discountTotal: 100n,
    });
    const b = line({ originalUnitPrice: 1000n, discountTotal: 100n });
    const lines = computeLineNets(order({ lines: [a, b] }), settings()).lines;
    expect(lines.map((l) => [l.gross, l.discount, l.exTax])).toEqual([
      [900n, 100n, 900n],
      [900n, 100n, 900n],
    ]);
  });

  it("removes tax after the discount on a discounted tax-inclusive line", () => {
    // 2 × £12.00 incl. VAT, 10% off → £21.60 incl. £3.60 VAT → £18.00 ex tax.
    const l = line({
      originalUnitPrice: 1200n,
      quantity: 2,
      discountTotal: 240n,
      tax: 360n,
    });
    const [result] = computeLineNets(
      order({ taxesIncluded: true, lines: [l] }),
      settings(),
    ).lines;
    expect(result).toMatchObject({
      gross: 2160n,
      discount: 240n,
      exTax: 1800n,
    });
  });

  it("handles a zero-decimal currency (JPY)", () => {
    // ¥1,200 × 3 incl. 10% consumption tax of ¥327; 15% commission of
    // ¥3,273 is ¥490.95 → ¥491.
    const l = line({ originalUnitPrice: 1200n, quantity: 3, tax: 327n });
    const [result] = computeLineNets(
      order({ currency: "JPY", taxesIncluded: true, lines: [l] }),
      settings({ commissionPercent: "15" }),
    ).lines;
    expect(result).toMatchObject({
      gross: 3600n,
      exTax: 3273n,
      commission: 491n,
      net: 2782n,
    });
  });

  it("handles a three-decimal currency (KWD)", () => {
    // 12.500 KWD at 12.5% commission = 1.5625 → 1.563 (half away from zero).
    const l = line({ originalUnitPrice: 12500n });
    const [result] = computeLineNets(
      order({ currency: "KWD", lines: [l] }),
      settings({ commissionPercent: "12.5" }),
    ).lines;
    expect(result).toMatchObject({
      exTax: 12500n,
      commission: 1563n,
      net: 10937n,
    });
  });

  it("keeps a zero-priced line with all-zero amounts", () => {
    const priced = line({ originalUnitPrice: 1000n });
    const free = line({ originalUnitPrice: 0n });
    const result = computeLineNets(
      order({
        lines: [priced, free],
        shipping: { amount: 500n, tax: 0n },
        fee: { fee: 59n, charge: 2000n },
      }),
      settings({ includeShipping: true, cardFeeMode: "actual" }),
    );
    expect(result.lines[1]).toEqual({
      lineId: free.id,
      gross: 0n,
      discount: 0n,
      exTax: 0n,
      commission: 0n,
      fees: 0n,
      shipping: 0n,
      net: 0n,
    });
    // The priced line carries all the shipping and the whole fee.
    expect(result.lines[0]).toMatchObject({ shipping: 500n, fees: 30n });
  });
});

describe("computeLineNets: commission", () => {
  it("is a percentage of ex-tax, not of gross", () => {
    const l = line({ originalUnitPrice: 1200n, tax: 200n });
    const [result] = computeLineNets(
      order({ taxesIncluded: true, lines: [l] }),
      settings({ commissionPercent: "15" }),
    ).lines;
    expect(result).toMatchObject({ exTax: 1000n, commission: 150n, net: 850n });
  });

  it("rounds a half minor unit away from zero", () => {
    // 15% of 10p = 1.5p → 2p; 15% of 30p = 4.5p → 5p.
    const a = line({ originalUnitPrice: 10n });
    const b = line({ originalUnitPrice: 30n });
    const lines = computeLineNets(
      order({ lines: [a, b] }),
      settings({ commissionPercent: "15" }),
    ).lines;
    expect(lines.map((l) => l.commission)).toEqual([2n, 5n]);
  });

  it("is zero when no commission is set", () => {
    const [result] = computeLineNets(order(), settings()).lines;
    expect(result?.commission).toBe(0n);
  });
});

describe("computeLineNets: card fees", () => {
  it("none: no fee", () => {
    const result = computeLineNets(
      order({ fee: { fee: 59n, charge: 2000n } }),
      settings({ cardFeeMode: "none", flatFeePercent: "2.9" }),
    );
    expect(result.lines[0]?.fees).toBe(0n);
    expect(result.feeFallback).toBe(false);
  });

  it("flat: a percentage of each line's ex-tax, rounded per line", () => {
    // 2.9% of £10.00 = 29p; 2.9% of £10.50 = 30.45p → 30p.
    const a = line({ originalUnitPrice: 1000n });
    const b = line({ originalUnitPrice: 1050n });
    const result = computeLineNets(
      order({ lines: [a, b] }),
      settings({ cardFeeMode: "flat", flatFeePercent: "2.9" }),
    );
    expect(result.lines.map((l) => l.fees)).toEqual([29n, 30n]);
    expect(result.feeFallback).toBe(false);
    result.lines.forEach(expectNetIdentity);
  });

  it("stacks with commission, each taken from ex-tax (not compounded)", () => {
    const [result] = computeLineNets(
      order(),
      settings({
        commissionPercent: "15",
        cardFeeMode: "flat",
        flatFeePercent: "2.9",
        commissionExcludesFeesConfirmed: true,
      }),
    ).lines;
    expect(result).toMatchObject({ commission: 150n, fees: 29n, net: 821n });
  });

  it("actual: applies the settlement-currency fee ratio to a foreign-currency order", () => {
    // Fee 0.59 GBP on a 20.00 GBP charge, applied to an NZD order: never
    // converted, only used as a ratio. 4500 × 59 / 2000 = 132.75 → 133,
    // split 2:1 by ex-tax → 88.67 / 44.33 → 89 + 44.
    const a = line({ originalUnitPrice: 3000n });
    const b = line({ originalUnitPrice: 1500n });
    const result = computeLineNets(
      order({
        currency: "NZD",
        lines: [a, b],
        fee: { fee: 59n, charge: 2000n },
      }),
      settings({ cardFeeMode: "actual" }),
    );
    expect(result.lines.map((l) => l.fees)).toEqual([89n, 44n]);
    expect(result.lines.map((l) => l.net)).toEqual([2911n, 1456n]);
    expect(result.feeFallback).toBe(false);
  });

  it("actual: the fee is on what the customer paid, VAT included", () => {
    // The processor takes its fee on the whole charge, so the VAT is
    // fee-bearing.
    const l = line({ originalUnitPrice: 1200n, tax: 200n });
    const [result] = computeLineNets(
      order({ taxesIncluded: true, lines: [l], fee: { fee: 1n, charge: 10n } }),
      settings({ cardFeeMode: "actual" }),
    ).lines;
    expect(result?.fees).toBe(120n);
    expect(result?.net).toBe(880n);
  });

  it("flat: the rate is on the charge with its VAT, on a tax-exclusive order too", () => {
    // Book A 10.00 + 2.00 VAT: 1.4% of 12.00 = 0.168 → 0.17.
    const l = line({ originalUnitPrice: 1000n, tax: 200n });
    const [result] = computeLineNets(
      order({ taxesIncluded: false, lines: [l] }),
      settings({ cardFeeMode: "flat", flatFeePercent: "1.4" }),
    ).lines;
    expect(result).toMatchObject({ exTax: 1000n, fees: 17n, net: 983n });
  });

  it("actual with an unknown fee falls back to the flat percent and flags it", () => {
    const result = computeLineNets(
      order({ fee: null }),
      settings({ cardFeeMode: "actual", flatFeePercent: "2.9" }),
    );
    expect(result.lines[0]?.fees).toBe(29n);
    expect(result.feeFallback).toBe(true);
    expect(result.flatFeeMissing).toBe(false);
  });

  it("actual with an unknown fee and no flat percent deducts nothing and flags both", () => {
    const result = computeLineNets(
      order({ fee: null }),
      settings({ cardFeeMode: "actual", flatFeePercent: null }),
    );
    expect(result.lines[0]?.fees).toBe(0n);
    expect(result.feeFallback).toBe(true);
    expect(result.flatFeeMissing).toBe(true);
  });

  it("actual with a zero charge is treated as an unknown fee", () => {
    // A ratio over a zero charge has no meaning; falling back is safer than
    // either throwing mid-build or deducting nothing silently.
    const result = computeLineNets(
      order({ fee: { fee: 0n, charge: 0n } }),
      settings({ cardFeeMode: "actual", flatFeePercent: "2.9" }),
    );
    expect(result.lines[0]?.fees).toBe(29n);
    expect(result.feeFallback).toBe(true);
  });

  it("flat mode with no percent deducts nothing and flags it", () => {
    const result = computeLineNets(
      order(),
      settings({ cardFeeMode: "flat", flatFeePercent: null }),
    );
    expect(result.lines[0]?.fees).toBe(0n);
    expect(result.flatFeeMissing).toBe(true);
    expect(result.feeFallback).toBe(false);
  });
});

describe("computeLineNets: shipping", () => {
  const twoLines = () => [
    line({ originalUnitPrice: 3000n }),
    line({ originalUnitPrice: 1500n }),
  ];

  it("is excluded by default", () => {
    const result = computeLineNets(
      order({ lines: twoLines(), shipping: { amount: 499n, tax: 83n } }),
      settings({ includeShipping: false }),
    );
    expect(result.lines.map((l) => l.shipping)).toEqual([0n, 0n]);
    expect(result.unallocatedShipping).toBe(0n);
  });

  it("when included, allocates ex-tax shipping by line ex-tax", () => {
    // £4.99 incl. 83p VAT → 416p; 2:1 → 277.33 / 138.67 → 277 + 139.
    const result = computeLineNets(
      order({
        taxesIncluded: true,
        lines: twoLines(),
        shipping: { amount: 499n, tax: 83n },
      }),
      settings({ includeShipping: true }),
    );
    expect(result.lines.map((l) => l.shipping)).toEqual([277n, 139n]);
    expect(result.lines.map((l) => l.net)).toEqual([3277n, 1639n]);
    result.lines.forEach(expectNetIdentity);
  });

  it("does not subtract shipping tax on a tax-exclusive order", () => {
    const result = computeLineNets(
      order({ lines: twoLines(), shipping: { amount: 450n, tax: 36n } }),
      settings({ includeShipping: true }),
    );
    expect(sum(result.lines.map((l) => l.shipping))).toBe(450n);
  });

  it("falls back to quantity weights when every line is zero-priced", () => {
    const result = computeLineNets(
      order({
        lines: [
          line({ originalUnitPrice: 0n, quantity: 1 }),
          line({ originalUnitPrice: 0n, quantity: 3 }),
        ],
        shipping: { amount: 400n, tax: 0n },
      }),
      settings({ includeShipping: true }),
    );
    expect(result.lines.map((l) => l.shipping)).toEqual([100n, 300n]);
  });

  it("is commissioned with the goods, but not fee-bearing", () => {
    const [result] = computeLineNets(
      order({ shipping: { amount: 500n, tax: 0n } }),
      settings({
        includeShipping: true,
        commissionPercent: "10",
        cardFeeMode: "flat",
        flatFeePercent: "2",
        commissionExcludesFeesConfirmed: true,
      }),
    ).lines;
    // Commission is 10% of goods + shipping, 15.00 → 1.50; the flat fee
    // stays on the goods' charge, 2% of 10.00 → 0.20.
    expect(result).toMatchObject({
      commission: 150n,
      fees: 20n,
      shipping: 500n,
      net: 1330n,
    });
  });
});

describe("computeLineNets: gift cards", () => {
  it("drops gift-card lines and keeps them out of fee and shipping weights", () => {
    const book = line({ originalUnitPrice: 1000n });
    const giftCard = line({ originalUnitPrice: 5000n, isGiftCard: true });
    const result = computeLineNets(
      order({
        lines: [giftCard, book],
        shipping: { amount: 300n, tax: 0n },
        fee: { fee: 1n, charge: 100n },
      }),
      settings({ includeShipping: true, cardFeeMode: "actual" }),
    );
    expect(result.lines.map((l) => l.lineId)).toEqual([book.id]);
    // 1% of the book's £10.00 only, not of the £60.00 order.
    expect(result.lines[0]).toMatchObject({ fees: 10n, shipping: 300n });
  });

  it("reports shipping it could not place when only gift cards were sold", () => {
    const result = computeLineNets(
      order({
        lines: [line({ isGiftCard: true })],
        shipping: { amount: 300n, tax: 0n },
      }),
      settings({ includeShipping: true }),
    );
    expect(result.lines).toEqual([]);
    expect(result.unallocatedShipping).toBe(300n);
  });
});

describe("computeLineNets: output", () => {
  it("returns shares for every non-gift-card line, whatever its product flags", () => {
    // Dropping unticked lines is the caller's job: their
    // share must still be computed so ticked lines do not absorb it.
    const lines = [line(), line(), line()];
    const result = computeLineNets(order({ lines }), settings());
    expect(result.lines.map((l) => l.lineId)).toEqual(lines.map((l) => l.id));
  });

  it("carries the order id", () => {
    expect(computeLineNets(order({ id: "o-7" }), settings()).orderId).toBe(
      "o-7",
    );
  });
});
