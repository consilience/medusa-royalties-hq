import { computeLineNets } from "../../rows/lineNet";
import { computeRefundNets } from "../../rows/refundNet";
import type { CoreSettings } from "../../types";
import { mulberry32, randInt } from "../../__tests__/support/prng";
import { fullRefund, line, order, settings } from "../../__tests__/support/builders";

describe("computeRefundNets", () => {
  it("reverses the sign: tax removed, commission and flat fee mirrored", () => {
    // Refund of a £12.00 incl. VAT line: −£10.00 ex tax, −£1.50 commission
    // (of ex tax), −35p fee (2.9% of the £12.00 charge, VAT included);
    // the net is −£8.15.
    const l = line({ originalUnitPrice: 1200n, tax: 200n });
    const o = order({ taxesIncluded: true, lines: [l] });
    const result = computeRefundNets(
      o,
      fullRefund(o),
      settings({
        commissionPercent: "15",
        cardFeeMode: "flat",
        flatFeePercent: "2.9",
        commissionExcludesFeesConfirmed: true,
      }),
    );
    expect(result.lines).toEqual([
      {
        lineId: l.id,
        units: 1,
        gross: -1200n,
        exTax: -1000n,
        commission: -150n,
        fees: -35n,
        shipping: 0n,
        net: -815n,
      },
    ]);
  });

  it("does not subtract tax on a tax-exclusive order", () => {
    const l = line({ originalUnitPrice: 1000n, tax: 80n });
    const o = order({ lines: [l] });
    const [result] = computeRefundNets(o, fullRefund(o), settings()).lines;
    expect(result).toMatchObject({ gross: -1000n, exTax: -1000n });
  });

  it("rounds a half-unit commission away from zero, mirroring the sale", () => {
    const l = line({ originalUnitPrice: 10n });
    const o = order({ lines: [l] });
    const s = settings({ commissionPercent: "15" });
    expect(computeLineNets(o, s).lines[0]?.commission).toBe(2n);
    expect(computeRefundNets(o, fullRefund(o), s).lines[0]?.commission).toBe(
      -2n,
    );
  });

  it("reports refunded units as the refunded quantity (positive count)", () => {
    const l = line({ originalUnitPrice: 1000n, quantity: 3 });
    const o = order({ lines: [l] });
    const result = computeRefundNets(
      o,
      {
        id: "r1",
        createdAt: "2026-08-20T00:00:00Z",
        lines: [{ lineId: l.id, quantity: 2, amount: 2000n, tax: 0n }],
        shipping: { amount: 0n, tax: 0n },
      },
      settings(),
    );
    expect(result.lines[0]).toMatchObject({ units: 2, exTax: -2000n });
    expect(result.refundId).toBe("r1");
    expect(result.orderId).toBe(o.id);
  });

  it("applies the original order's actual fee ratio", () => {
    // Same NZD order and GBP fee ratio as the sale test: −133 split −89/−44.
    const a = line({ originalUnitPrice: 3000n });
    const b = line({ originalUnitPrice: 1500n });
    const o = order({
      currency: "NZD",
      lines: [a, b],
      fee: { fee: 59n, charge: 2000n },
    });
    const result = computeRefundNets(
      o,
      fullRefund(o),
      settings({ cardFeeMode: "actual" }),
    );
    expect(result.lines.map((l) => l.fees)).toEqual([-89n, -44n]);
    expect(result.feeFallback).toBe(false);
  });

  it("falls back to the flat percent when the order's fee is unknown", () => {
    const o = order({ fee: null });
    const result = computeRefundNets(
      o,
      fullRefund(o),
      settings({ cardFeeMode: "actual", flatFeePercent: "2.9" }),
    );
    expect(result.lines[0]?.fees).toBe(-29n);
    expect(result.feeFallback).toBe(true);
  });

  it("allocates refunded shipping to the refunded lines only when included", () => {
    const a = line({ originalUnitPrice: 3000n });
    const b = line({ originalUnitPrice: 1000n });
    const o = order({ lines: [a, b], shipping: { amount: 500n, tax: 0n } });
    const refund = {
      id: "r1",
      createdAt: "2026-08-20T00:00:00Z",
      lines: [{ lineId: b.id, quantity: 1, amount: 1000n, tax: 0n }],
      shipping: { amount: 500n, tax: 0n },
    };
    const included = computeRefundNets(
      o,
      refund,
      settings({ includeShipping: true }),
    );
    expect(included.lines).toHaveLength(1);
    expect(included.lines[0]).toMatchObject({
      lineId: b.id,
      shipping: -500n,
      net: -1500n,
    });

    const excluded = computeRefundNets(o, refund, settings());
    expect(excluded.lines[0]).toMatchObject({ shipping: 0n, net: -1000n });
  });

  it("removes tax from refunded shipping on a tax-inclusive order", () => {
    const l = line({ originalUnitPrice: 1200n, tax: 200n });
    const o = order({
      taxesIncluded: true,
      lines: [l],
      shipping: { amount: 480n, tax: 80n },
    });
    const [result] = computeRefundNets(
      o,
      fullRefund(o),
      settings({ includeShipping: true }),
    ).lines;
    expect(result?.shipping).toBe(-400n);
  });

  it("allocates a shipping-only refund across the order's sale lines, with no units", () => {
    // £10.00 book + £5.00 shipping, then £5.00 of shipping refunded alone.
    // The sale carried the shipping, so its refund must come off too; with
    // no refunded lines to follow, it follows the sale's own weights.
    const l = line({ originalUnitPrice: 1000n });
    const o = order({ lines: [l], shipping: { amount: 500n, tax: 0n } });
    const result = computeRefundNets(
      o,
      {
        id: "r1",
        createdAt: "2026-08-20T00:00:00Z",
        lines: [],
        shipping: { amount: 500n, tax: 0n },
      },
      settings({ includeShipping: true }),
    );
    expect(result.lines).toEqual([
      {
        lineId: l.id,
        units: 0,
        gross: 0n,
        exTax: 0n,
        commission: 0n,
        fees: 0n,
        shipping: -500n,
        net: -500n,
      },
    ]);
    expect(result.unallocatedShipping).toBe(0n);
  });

  it("weights a shipping-only refund by the sale lines' ex-tax", () => {
    const a = line({ originalUnitPrice: 1200n, tax: 200n });
    const b = line({ originalUnitPrice: 3600n, tax: 600n });
    const o = order({
      taxesIncluded: true,
      lines: [a, b],
      shipping: { amount: 480n, tax: 80n },
    });
    const result = computeRefundNets(
      o,
      {
        id: "r1",
        createdAt: "2026-08-20T00:00:00Z",
        lines: [],
        shipping: { amount: 480n, tax: 80n },
      },
      settings({ includeShipping: true }),
    );
    expect(result.lines.map((x) => [x.lineId, x.units, x.shipping])).toEqual([
      [a.id, 0, -100n],
      [b.id, 0, -300n],
    ]);
  });

  it("leaves a shipping-only refund alone when shipping is not included", () => {
    const o = order({ shipping: { amount: 500n, tax: 0n } });
    const result = computeRefundNets(
      o,
      {
        id: "r1",
        createdAt: "2026-08-20T00:00:00Z",
        lines: [],
        shipping: { amount: 500n, tax: 0n },
      },
      settings({ includeShipping: false }),
    );
    expect(result.lines).toEqual([]);
    expect(result.unallocatedShipping).toBe(0n);
  });

  it("reports refunded shipping it could not place when the order has no royalty lines", () => {
    const o = order({
      lines: [line({ isGiftCard: true })],
      shipping: { amount: 500n, tax: 0n },
    });
    const result = computeRefundNets(
      o,
      {
        id: "r1",
        createdAt: "2026-08-20T00:00:00Z",
        lines: [],
        shipping: { amount: 500n, tax: 0n },
      },
      settings({ includeShipping: true }),
    );
    expect(result.lines).toEqual([]);
    expect(result.unallocatedShipping).toBe(-500n);
  });

  it("drops refunded gift-card lines", () => {
    const book = line();
    const giftCard = line({ isGiftCard: true, originalUnitPrice: 5000n });
    const o = order({ lines: [book, giftCard] });
    const result = computeRefundNets(o, fullRefund(o), settings());
    expect(result.lines.map((l) => l.lineId)).toEqual([book.id]);
  });

  it("throws on a refund line that is not on the order", () => {
    // A refund pointing at a line the ledger does not hold means the ledger
    // is wrong; guessing its tax basis or gift-card status would be worse.
    const o = order();
    expect(() =>
      computeRefundNets(
        o,
        {
          id: "r1",
          createdAt: "2026-08-20T00:00:00Z",
          lines: [{ lineId: "nope", quantity: 1, amount: 100n, tax: 0n }],
          shipping: { amount: 0n, tax: 0n },
        },
        settings(),
      ),
    ).toThrow(/nope/);
  });
});

describe("a full refund exactly undoes the sale, line by line", () => {
  const modes: Partial<CoreSettings>[] = [
    {},
    { commissionPercent: "15" },
    { cardFeeMode: "flat", flatFeePercent: "2.9" },
    { cardFeeMode: "actual", flatFeePercent: "2.9" },
    {
      commissionPercent: "12.5",
      cardFeeMode: "actual",
      commissionExcludesFeesConfirmed: true,
      includeShipping: true,
    },
    {
      commissionPercent: "15",
      cardFeeMode: "flat",
      flatFeePercent: "3.4",
      commissionExcludesFeesConfirmed: true,
      includeShipping: true,
    },
  ];

  it.each(modes.map((m) => [JSON.stringify(m), m] as const))(
    "with settings %s",
    (_label, overrides) => {
      const s = settings(overrides);
      const rng = mulberry32(20260927);
      for (let run = 0; run < 200; run++) {
        const taxesIncluded = rng() < 0.5;
        const lines = Array.from({ length: randInt(rng, 1, 5) }, () => {
          const quantity = randInt(rng, 1, 4);
          const unit = BigInt(randInt(rng, 0, 5000));
          const discountTotal =
            (BigInt(randInt(rng, 0, 100)) * unit * BigInt(quantity)) / 1000n;
          const gross = unit * BigInt(quantity) - discountTotal;
          return line({
            quantity,
            originalUnitPrice: unit,
            discountTotal,
            tax: taxesIncluded ? gross / 6n : gross / 10n,
            isGiftCard: rng() < 0.1,
          });
        });
        const o = order({
          taxesIncluded,
          lines,
          shipping: { amount: BigInt(randInt(rng, 0, 999)), tax: 0n },
          fee:
            rng() < 0.8
              ? {
                  fee: BigInt(randInt(rng, 1, 200)),
                  charge: BigInt(randInt(rng, 1000, 9999)),
                }
              : null,
        });
        const sale = computeLineNets(o, s);
        const refund = computeRefundNets(o, fullRefund(o), s);
        expect(refund.lines.map((l) => l.lineId)).toEqual(
          sale.lines.map((l) => l.lineId),
        );
        sale.lines.forEach((sold, i) => {
          const back = refund.lines[i]!;
          expect(back.units).toBe(
            lines.find((l) => l.id === sold.lineId)!.quantity,
          );
          for (const key of [
            "gross",
            "exTax",
            "commission",
            "fees",
            "shipping",
            "net",
          ] as const) {
            expect(sold[key] + back[key]).toBe(0n);
          }
          expect(back.net).toBe(
            back.exTax - back.commission - back.fees + back.shipping,
          );
        });
        expect(sale.unallocatedShipping + refund.unallocatedShipping).toBe(0n);
      }
    },
  );

  describe("deductions above the line's value (actual fees)", () => {
    // Commission 100% plus a 3% actual fee: the fee would take the sale's net
    // to −3% and the refund's to +3%. A deduction may reduce a line to zero
    // but never flip its sign, so the fee is cut back and the line counted.
    const s = settings({
      commissionPercent: "100",
      cardFeeMode: "actual",
      flatFeePercent: null,
      commissionExcludesFeesConfirmed: true,
    });
    const l = line({ originalUnitPrice: 1000n });
    const o = order({ lines: [l], fee: { fee: 3n, charge: 100n } });

    it("clamps the sale net at zero and counts it", () => {
      const sale = computeLineNets(o, s);
      expect(sale.lines[0]).toMatchObject({
        exTax: 1000n,
        commission: 1000n,
        fees: 0n,
        net: 0n,
      });
      expect(sale.netsClamped).toBe(1);
    });

    it("clamps the refund net at zero and counts it", () => {
      const refund = computeRefundNets(o, fullRefund(o), s);
      expect(refund.lines[0]).toMatchObject({
        exTax: -1000n,
        commission: -1000n,
        fees: 0n,
        net: 0n,
      });
      expect(refund.netsClamped).toBe(1);
    });

    it("does not clamp an ordinary line", () => {
      const ordinary = settings({ cardFeeMode: "actual" });
      expect(computeLineNets(o, ordinary).netsClamped).toBe(0);
      expect(computeRefundNets(o, fullRefund(o), ordinary).netsClamped).toBe(0);
    });
  });
});
