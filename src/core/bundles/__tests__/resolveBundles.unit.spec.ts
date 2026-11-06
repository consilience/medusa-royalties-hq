import { resolveBundles } from "../../bundles";
import { computeLineNets } from "../../rows/lineNet";
import { computeRefundNets } from "../../rows/refundNet";
import type {
  CoreLine,
  CoreRefund,
  ProductConfig,
} from "../../types";
import { line, order, settings } from "../../__tests__/support/builders";

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

function product(
  variantId: string,
  overrides: Partial<ProductConfig> = {},
): ProductConfig {
  return {
    variantId,
    included: true,
    rhqProductId: null,
    isbnSourceValue: null,
    sku: null,
    asin: null,
    title: variantId,
    regularUnitPrice: null,
    bundleComponents: null,
    ...overrides,
  };
}

function catalog(...ps: ProductConfig[]): Map<string, ProductConfig> {
  return new Map(ps.map((p) => [p.variantId, p]));
}

const group = (id: string): CoreLine["group"] => ({
  id,
  title: "Bundle",
  quantity: 1,
  variantId: "9999",
});

function refund(
  id: string,
  lines: CoreRefund["lines"],
  shipping = { amount: 0n, tax: 0n },
): CoreRefund {
  return { id, createdAt: "2026-08-12T12:00:00Z", lines, shipping };
}

describe("resolveBundles: ordinary lines", () => {
  it("passes plain lines through with their own line nets", () => {
    const a = line({ originalUnitPrice: 1200n, quantity: 2, tax: 400n });
    const o = order({ taxesIncluded: true, lines: [a] });
    const s = settings({ commissionPercent: "10" });
    const [net] = computeLineNets(o, s).lines;
    const result = resolveBundles(o, catalog(product(a.variantId!)), s);
    expect(result.sale.lines).toEqual([
      {
        lineId: a.id,
        sourceLineIds: [a.id],
        variantId: a.variantId,
        quantity: 2,
        gross: net!.gross,
        discount: net!.discount,
        exTax: net!.exTax,
        commission: net!.commission,
        fees: net!.fees,
        shipping: net!.shipping,
        net: net!.net,
        // £12 incl. VAT scaled by the line's exTax ÷ gross (2000 ÷ 2400).
        listPriceExTax: 1000n,
        included: true,
        bundle: null,
      },
    ]);
  });

  it("prefers the recorded order-time regular price for list price", () => {
    const a = line({ originalUnitPrice: 800n, regularUnitPrice: 1000n });
    const result = resolveBundles(
      order({ lines: [a] }),
      catalog(product(a.variantId!, { regularUnitPrice: 1200n })),
      settings(),
    );
    expect(result.sale.lines[0]!.listPriceExTax).toBe(1000n);
  });

  it("marks a line with no product config as not included", () => {
    const a = line();
    const result = resolveBundles(order({ lines: [a] }), catalog(), settings());
    expect(result.sale.lines[0]!.included).toBe(false);
  });

  it("drops gift-card lines entirely", () => {
    const a = line();
    const gift = line({ isGiftCard: true, originalUnitPrice: 2000n });
    const result = resolveBundles(
      order({ lines: [a, gift] }),
      catalog(product(a.variantId!), product(gift.variantId!)),
      settings(),
    );
    expect(result.sale.lines.map((l) => l.lineId)).toEqual([a.id]);
  });

  it("strips tax from a free line's list price by the order's own tax ratio", () => {
    // A free copy records no tax, so it has no ratio of its own; the paid
    // line beside it (12.00 incl. 2.00 tax) supplies one, as the breakdown's
    // discount does.
    const paid = line({ originalUnitPrice: 1200n, tax: 200n });
    const free = line({ originalUnitPrice: 1200n, discountTotal: 1200n });
    const result = resolveBundles(
      order({ taxesIncluded: true, lines: [paid, free] }),
      catalog(product(paid.variantId!), product(free.variantId!)),
      settings(),
    );
    expect(result.sale.lines.map((l) => l.listPriceExTax)).toEqual([
      1000n,
      1000n,
    ]);
  });

  it("uses the list price as is on a wholly free tax-inclusive order (no tax was charged)", () => {
    const a = line({ originalUnitPrice: 1200n, discountTotal: 1200n });
    const result = resolveBundles(
      order({ taxesIncluded: true, lines: [a] }),
      catalog(product(a.variantId!)),
      settings(),
    );
    expect(result.sale.lines[0]!.listPriceExTax).toBe(1200n);
  });

  it("gives a zero-priced line on a wholly free tax-inclusive order a zero list price", () => {
    const a = line({ originalUnitPrice: 0n });
    const result = resolveBundles(
      order({ taxesIncluded: true, lines: [a] }),
      catalog(product(a.variantId!)),
      settings(),
    );
    expect(result.sale.lines[0]!.listPriceExTax).toBe(0n);
  });

  it("passes the order-level flags from line net through", () => {
    const a = line({ isGiftCard: true });
    const result = resolveBundles(
      order({ lines: [a], shipping: { amount: 300n, tax: 0n } }),
      catalog(),
      settings({ includeShipping: true, cardFeeMode: "actual" }),
    );
    expect(result.sale).toMatchObject({
      feeFallback: true,
      flatFeeMissing: true,
      unallocatedShipping: 300n,
    });
  });
});

describe("resolveBundles: platform_allocation guard", () => {
  it("holds when an unticked component is at zero (only included components count)", () => {
    const a = line({ originalUnitPrice: 2500n, group: group("G") });
    const tote = line({ originalUnitPrice: 0n, group: group("G") });
    const result = resolveBundles(
      order({ lines: [a, tote] }),
      catalog(
        product(a.variantId!),
        product(tote.variantId!, { included: false }),
      ),
      settings({ bundleSplit: "platform_allocation" }),
    );
    expect(result.sale.lines.map((l) => l.exTax)).toEqual([2500n, 0n]);
    expect(result.notes.bundleSplitFallbacks).toEqual([]);
  });

  it("holds when every component is at zero (nothing is being over-paid)", () => {
    const a = line({ originalUnitPrice: 0n, group: group("G") });
    const b = line({ originalUnitPrice: 0n, group: group("G") });
    const result = resolveBundles(
      order({ lines: [a, b] }),
      catalog(product(a.variantId!), product(b.variantId!)),
      settings({ bundleSplit: "platform_allocation" }),
    );
    expect(result.sale.lines.map((l) => l.bundle?.method)).toEqual([
      "platform_allocation",
      "platform_allocation",
    ]);
    expect(result.notes.bundleSplitFallbacks).toEqual([]);
  });

  it("fails when an included component is zeroed by a 100% discount beside a priced one", () => {
    const a = line({ originalUnitPrice: 1000n, group: group("G") });
    const b = line({
      originalUnitPrice: 1000n,
      discountTotal: 1000n,
      group: group("G"),
    });
    const result = resolveBundles(
      order({ lines: [a, b] }),
      catalog(product(a.variantId!), product(b.variantId!)),
      settings({ bundleSplit: "platform_allocation", bundleFallback: "even" }),
    );
    expect(result.sale.lines.map((l) => l.exTax)).toEqual([500n, 500n]);
    expect(result.notes.bundleSplitFallbacks).toEqual([
      {
        ref: { kind: "group", groupId: "G" },
        reason: "zero_priced_component",
        method: "even",
      },
    ]);
  });

  it("keeps two separate groups in one order apart", () => {
    const a = line({ originalUnitPrice: 1000n, group: group("G1") });
    const b = line({ originalUnitPrice: 0n, group: group("G1") });
    const c = line({ originalUnitPrice: 700n, group: group("G2") });
    const d = line({ originalUnitPrice: 300n, group: group("G2") });
    const result = resolveBundles(
      order({ lines: [a, c, b, d] }),
      catalog(...[a, b, c, d].map((l) => product(l.variantId!))),
      settings({ bundleSplit: "platform_allocation", bundleFallback: "even" }),
    );
    // Output keeps the order's line order.
    expect(result.sale.lines.map((l) => [l.lineId, l.exTax])).toEqual([
      [a.id, 500n],
      [c.id, 700n],
      [b.id, 500n],
      [d.id, 300n],
    ]);
    expect(result.sale.lines[0]!.sourceLineIds).toEqual([a.id, b.id]);
    expect(result.sale.lines[1]!.sourceLineIds).toEqual([c.id]);
  });
});

describe("resolveBundles: price_ratio weights", () => {
  it("uses the order-time regular price before the catalog price", () => {
    const a = line({
      originalUnitPrice: 1000n,
      regularUnitPrice: 300n,
      group: group("G"),
    });
    const b = line({ originalUnitPrice: 0n, group: group("G") });
    const result = resolveBundles(
      order({ lines: [a, b] }),
      catalog(
        product(a.variantId!, { regularUnitPrice: 100n }),
        product(b.variantId!, { regularUnitPrice: 100n }),
      ),
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(result.sale.lines.map((l) => l.exTax)).toEqual([750n, 250n]);
  });

  it("falls back to quantity when a component's price is unknown, and notes it", () => {
    const a = line({ originalUnitPrice: 900n, quantity: 2, group: group("G") });
    const b = line({ originalUnitPrice: 0n, group: group("G") });
    const result = resolveBundles(
      order({ lines: [a, b] }),
      catalog(
        product(a.variantId!, { regularUnitPrice: 1000n }),
        product(b.variantId!),
      ),
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(result.sale.lines.map((l) => l.exTax)).toEqual([1200n, 600n]);
    expect(result.sale.lines.map((l) => l.bundle?.method)).toEqual([
      "even",
      "even",
    ]);
    expect(result.notes.bundleSplitFallbacks).toEqual([
      {
        ref: { kind: "group", groupId: "G" },
        reason: "price_unknown",
        method: "even",
      },
    ]);
  });

  it("falls back to quantity when every price is zero, and notes it", () => {
    const a = line({ originalUnitPrice: 500n, group: group("G") });
    const b = line({ originalUnitPrice: 500n, quantity: 3, group: group("G") });
    const result = resolveBundles(
      order({ lines: [a, b] }),
      catalog(
        product(a.variantId!, { regularUnitPrice: 0n }),
        product(b.variantId!, { regularUnitPrice: 0n }),
      ),
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(result.sale.lines.map((l) => l.exTax)).toEqual([500n, 1500n]);
    expect(result.notes.bundleSplitFallbacks[0]!.reason).toBe(
      "prices_all_zero",
    );
  });

  it("splits commission, fees and shipping with the same weights, preserving every total", () => {
    const a = line({ originalUnitPrice: 1999n, tax: 333n, group: group("G") });
    const b = line({ originalUnitPrice: 1n, group: group("G") });
    const c = line({ originalUnitPrice: 700n, tax: 117n });
    const o = order({
      taxesIncluded: true,
      lines: [a, b, c],
      shipping: { amount: 499n, tax: 83n },
      fee: { fee: 29n, charge: 1000n },
    });
    const s = settings({
      bundleSplit: "price_ratio",
      commissionPercent: "12.5",
      cardFeeMode: "actual",
      commissionExcludesFeesConfirmed: true,
      includeShipping: true,
    });
    const nets = computeLineNets(o, s).lines;
    const result = resolveBundles(
      o,
      catalog(
        product(a.variantId!, { regularUnitPrice: 1200n }),
        product(b.variantId!, { regularUnitPrice: 1000n }),
        product(c.variantId!),
      ),
      s,
    );
    for (const k of [
      "gross",
      "discount",
      "exTax",
      "commission",
      "fees",
      "shipping",
      "net",
    ] as const) {
      expect(sum(result.sale.lines.map((l) => l[k]))).toBe(
        sum(nets.map((l) => l[k])),
      );
    }
    for (const l of result.sale.lines) {
      expect(l.net).toBe(l.exTax - l.commission - l.fees + l.shipping);
    }
    // The ordinary line is untouched by the bundle beside it.
    expect(result.sale.lines[2]!.net).toBe(nets[2]!.net);
  });

  it("scales a component's list price by the group's exTax ÷ gross on a tax-inclusive order", () => {
    const a = line({
      originalUnitPrice: 1200n,
      tax: 200n,
      group: group("G"),
    });
    const b = line({ originalUnitPrice: 0n, group: group("G") });
    const result = resolveBundles(
      order({ taxesIncluded: true, lines: [a, b] }),
      catalog(
        product(a.variantId!, { regularUnitPrice: 600n }),
        product(b.variantId!, { regularUnitPrice: 1200n }),
      ),
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(result.sale.lines.map((l) => l.listPriceExTax)).toEqual([
      500n,
      1000n,
    ]);
  });
});

describe("resolveBundles: native group refunds", () => {
  const a = line({
    originalUnitPrice: 2000n,
    regularUnitPrice: 1000n,
    group: group("G"),
  });
  const b = line({
    originalUnitPrice: 500n,
    regularUnitPrice: 1200n,
    group: group("G"),
  });
  const c = line({
    originalUnitPrice: 500n,
    regularUnitPrice: 800n,
    group: group("G"),
  });
  const products = catalog(
    product(a.variantId!),
    product(b.variantId!),
    product(c.variantId!),
  );

  it("under a re-weighted split, pools the refunded money over the refunded components by weight × refunded qty", () => {
    const r = refund("R", [
      { lineId: b.id, quantity: 1, amount: 500n, tax: 0n },
      { lineId: c.id, quantity: 1, amount: 500n, tax: 0n },
    ]);
    const result = resolveBundles(
      order({ lines: [a, b, c], refunds: [r] }),
      products,
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(result.refunds).toHaveLength(1);
    expect(
      result.refunds[0]!.lines.map((l) => [l.lineId, l.units, l.exTax]),
    ).toEqual([
      [b.id, 1, -600n],
      [c.id, 1, -400n],
    ]);
    expect(result.refunds[0]!.lines[0]!.sourceLineIds).toEqual([b.id, c.id]);
  });

  it("under platform allocation, leaves each component's refund with it", () => {
    const aa = line({ originalUnitPrice: 1000n, group: group("P") });
    const bb = line({ originalUnitPrice: 600n, group: group("P") });
    const r = refund("R", [
      { lineId: bb.id, quantity: 1, amount: 600n, tax: 0n },
    ]);
    const o = order({ lines: [aa, bb], refunds: [r] });
    const s = settings({ bundleSplit: "platform_allocation" });
    const expected = computeRefundNets(o, r, s).lines[0]!;
    const result = resolveBundles(
      o,
      catalog(product(aa.variantId!), product(bb.variantId!)),
      s,
    );
    expect(result.refunds[0]!.lines).toEqual([
      {
        lineId: bb.id,
        sourceLineIds: [bb.id],
        variantId: bb.variantId,
        units: 1,
        gross: expected.gross,
        exTax: expected.exTax,
        commission: expected.commission,
        fees: expected.fees,
        shipping: expected.shipping,
        net: expected.net,
        included: true,
        bundle: {
          ref: { kind: "group", groupId: "P" },
          method: "platform_allocation",
          title: "Bundle",
        },
      },
    ]);
  });

  it("spreads money refunded with no quantity over all components by the sale weights, with zero units", () => {
    const r = refund("R", [
      { lineId: a.id, quantity: 0, amount: 300n, tax: 0n },
    ]);
    const result = resolveBundles(
      order({ lines: [a, b, c], refunds: [r] }),
      products,
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(
      result.refunds[0]!.lines.map((l) => [l.lineId, l.units, l.exTax]),
    ).toEqual([
      [a.id, 0, -100n],
      [b.id, 0, -120n],
      [c.id, 0, -80n],
    ]);
  });

  it("a full refund exactly reverses a re-weighted sale", () => {
    const o0 = order({ lines: [a, b, c] });
    const r = refund(
      "R",
      o0.lines.map((l) => ({
        lineId: l.id,
        quantity: l.quantity,
        amount: l.originalUnitPrice,
        tax: 0n,
      })),
    );
    const result = resolveBundles(
      { ...o0, refunds: [r] },
      products,
      settings({ bundleSplit: "even", commissionPercent: "15" }),
    );
    expect(result.refunds[0]!.lines.map((l) => l.net)).toEqual(
      result.sale.lines.map((l) => -l.net),
    );
  });

  it("passes plain refund lines through and drops gift cards", () => {
    const p = line({ originalUnitPrice: 1000n });
    const gift = line({ isGiftCard: true });
    const r = refund("R", [
      { lineId: p.id, quantity: 1, amount: 1000n, tax: 0n },
      { lineId: gift.id, quantity: 1, amount: 1000n, tax: 0n },
    ]);
    const result = resolveBundles(
      order({ lines: [p, gift], refunds: [r] }),
      catalog(product(p.variantId!)),
      settings(),
    );
    expect(result.refunds[0]!.lines.map((l) => [l.lineId, l.exTax])).toEqual([
      [p.id, -1000n],
    ]);
    expect(result.refunds[0]!.lines[0]!.bundle).toBeNull();
  });
});

describe("resolveBundles: manual composition", () => {
  const A = "A";
  const B = "B";
  const M = "M";

  it("expands a line into component qty × line qty, taking included flags from the components", () => {
    const l = line({ variantId: M, originalUnitPrice: 3000n, quantity: 2 });
    const result = resolveBundles(
      order({ lines: [l] }),
      catalog(
        product(M, {
          included: true,
          bundleComponents: [
            { variantId: A, quantity: 2 },
            { variantId: B, quantity: 1 },
          ],
        }),
        product(A, { regularUnitPrice: 1000n }),
        product(B, { regularUnitPrice: 1000n, included: false }),
      ),
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(
      result.sale.lines.map((x) => [
        x.variantId,
        x.quantity,
        x.exTax,
        x.included,
      ]),
    ).toEqual([
      [A, 4, 4000n, true],
      [B, 2, 2000n, false],
    ]);
    expect(result.sale.lines[0]!.bundle).toEqual({
      ref: { kind: "manual", lineId: l.id },
      method: "price_ratio",
      title: l.title,
    });
  });

  it("treats a component with no config as unticked, notes it, and falls back to quantity for price_ratio", () => {
    const l = line({ variantId: M, originalUnitPrice: 1500n });
    const result = resolveBundles(
      order({ lines: [l] }),
      catalog(
        product(M, {
          bundleComponents: [
            { variantId: A, quantity: 1 },
            { variantId: B, quantity: 2 },
          ],
        }),
        product(A, { regularUnitPrice: 1000n }),
      ),
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(result.sale.lines.map((x) => [x.exTax, x.included])).toEqual([
      [500n, true],
      [1000n, false],
    ]);
    expect(result.notes.manualComponentsMissing).toEqual([
      { lineId: l.id, variantId: B },
    ]);
    expect(result.notes.bundleSplitFallbacks).toEqual([
      {
        ref: { kind: "manual", lineId: l.id },
        reason: "price_unknown",
        method: "even",
      },
    ]);
  });

  it("does not expand a line that is already in a native group", () => {
    const l = line({ variantId: M, group: group("G") });
    const result = resolveBundles(
      order({ lines: [l] }),
      catalog(
        product(M, { bundleComponents: [{ variantId: A, quantity: 1 }] }),
        product(A),
      ),
      settings({ bundleSplit: "platform_allocation" }),
    );
    expect(result.sale.lines.map((x) => x.variantId)).toEqual([M]);
  });

  it("treats an empty component list as no composition", () => {
    const l = line({ variantId: M });
    const result = resolveBundles(
      order({ lines: [l] }),
      catalog(product(M, { bundleComponents: [] })),
      settings(),
    );
    expect(result.sale.lines.map((x) => [x.variantId, x.bundle])).toEqual([
      [M, null],
    ]);
  });

  it("refuses a non-positive or fractional component quantity", () => {
    for (const quantity of [0, -1, 1.5]) {
      const l = line({ variantId: M });
      expect(() =>
        resolveBundles(
          order({ lines: [l] }),
          catalog(
            product(M, { bundleComponents: [{ variantId: A, quantity }] }),
            product(A),
          ),
          settings(),
        ),
      ).toThrow(/quantity/);
    }
  });

  it("splits a partial refund by the sale weights with units = component qty × refunded qty", () => {
    const l = line({ variantId: M, originalUnitPrice: 2000n, quantity: 3 });
    const r = refund("R", [
      { lineId: l.id, quantity: 2, amount: 4000n, tax: 0n },
    ]);
    const result = resolveBundles(
      order({ lines: [l], refunds: [r] }),
      catalog(
        product(M, {
          bundleComponents: [
            { variantId: A, quantity: 1 },
            { variantId: B, quantity: 3 },
          ],
        }),
        product(A, { regularUnitPrice: 500n }),
        product(B, { regularUnitPrice: 500n }),
      ),
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(
      result.refunds[0]!.lines.map((x) => [x.variantId, x.units, x.exTax]),
    ).toEqual([
      [A, 2, -1000n],
      [B, 6, -3000n],
    ]);
  });
});

describe("resolveBundles: unknown structure", () => {
  it("does not report a zero-priced line when nothing in the order is priced", () => {
    const a = line({ originalUnitPrice: 0n });
    const result = resolveBundles(
      order({ lines: [a] }),
      catalog(product(a.variantId!)),
      settings(),
    );
    expect(result.notes.unknownBundleLines).toEqual([]);
  });

  it("does not report zero-priced lines that are group components or manual bundles", () => {
    const M = "M";
    const priced = line({ originalUnitPrice: 1000n });
    const inGroup = line({ originalUnitPrice: 0n, group: group("G") });
    const manual = line({ variantId: M, originalUnitPrice: 0n });
    const result = resolveBundles(
      order({ lines: [priced, inGroup, manual] }),
      catalog(
        product(priced.variantId!),
        product(inGroup.variantId!),
        product(M, {
          bundleComponents: [
            { variantId: "A", quantity: 1 },
          ],
        }),
      ),
      settings(),
    );
    expect(result.notes.unknownBundleLines).toEqual([]);
  });

  it("does not report a zero-priced line whose product is unticked", () => {
    // An unticked free tote beside a priced book contributes nothing whether
    // it is a bundle component or not, so reporting it is only noise.
    const priced = line({ originalUnitPrice: 1000n });
    const tote = line({ originalUnitPrice: 0n });
    const result = resolveBundles(
      order({ lines: [priced, tote] }),
      catalog(
        product(priced.variantId!),
        product(tote.variantId!, { included: false }),
      ),
      settings(),
    );
    expect(result.notes.unknownBundleLines).toEqual([]);
  });

  it("reports the line's identity and quantity", () => {
    const priced = line({ originalUnitPrice: 1000n });
    const zero = line({ originalUnitPrice: 0n, quantity: 3 });
    const result = resolveBundles(
      order({ lines: [priced, zero] }),
      catalog(),
      settings(),
    );
    expect(result.notes.unknownBundleLines).toEqual([
      {
        lineId: zero.id,
        variantId: zero.variantId,
        title: zero.title,
        quantity: 3,
      },
    ]);
  });
});

describe("resolveBundles: sale-time context", () => {
  // The ledger records, at extraction, what inclusion, split method and
  // regular prices the sale was built with. A refund months later must
  // mirror that sale, not whatever the catalog and settings say today.

  it("uses the sale-time inclusion for the sale and its refunds", () => {
    const a = line({ originalUnitPrice: 1000n });
    const o = order({
      lines: [a],
      refunds: [
        refund("r1", [{ lineId: a.id, quantity: 1, amount: 1000n, tax: 0n }]),
      ],
      saleContext: {
        included: { [a.variantId!]: true },
        bundleSplit: "price_ratio",
        bundleFallback: "even",
        regularUnitPrices: {},
      },
    });
    const result = resolveBundles(
      o,
      catalog(product(a.variantId!, { included: false })),
      settings(),
    );
    expect(result.sale.lines[0]?.included).toBe(true);
    expect(result.refunds[0]?.lines[0]?.included).toBe(true);
  });

  it("falls back to current config for a variant the context does not mention", () => {
    const a = line({ originalUnitPrice: 1000n });
    const o = order({
      lines: [a],
      saleContext: {
        included: {},
        bundleSplit: "price_ratio",
        bundleFallback: "even",
        regularUnitPrices: {},
      },
    });
    const result = resolveBundles(
      o,
      catalog(product(a.variantId!, { included: false })),
      settings(),
    );
    expect(result.sale.lines[0]?.included).toBe(false);
  });

  it("splits a bundle refund by the sale-time method after the split setting changed", () => {
    // Sold under "even"; the shop has since switched to price_ratio with
    // catalog prices 3:1. Without the context the refund would be split 3:1
    // and no longer reverse the even sale.
    const a = line({ originalUnitPrice: 1000n, group: group("G") });
    const b = line({ originalUnitPrice: 1000n, group: group("G") });
    const o = order({
      lines: [a, b],
      refunds: [
        refund("r1", [
          { lineId: a.id, quantity: 1, amount: 1000n, tax: 0n },
          { lineId: b.id, quantity: 1, amount: 1000n, tax: 0n },
        ]),
      ],
      saleContext: {
        included: { [a.variantId!]: true, [b.variantId!]: true },
        bundleSplit: "even",
        bundleFallback: "even",
        regularUnitPrices: {},
      },
    });
    const result = resolveBundles(
      o,
      catalog(
        product(a.variantId!, { regularUnitPrice: 3000n }),
        product(b.variantId!, { regularUnitPrice: 1000n }),
      ),
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(result.sale.lines.map((l) => l.exTax)).toEqual([1000n, 1000n]);
    expect(result.refunds[0]?.lines.map((l) => l.exTax)).toEqual([
      -1000n,
      -1000n,
    ]);
    expect(result.sale.lines[0]?.bundle?.method).toBe("even");
  });

  it("weighs price_ratio by the sale-time regular prices, not today's catalog", () => {
    const a = line({ originalUnitPrice: 1000n, group: group("G") });
    const b = line({ originalUnitPrice: 1000n, group: group("G") });
    const o = order({
      lines: [a, b],
      saleContext: {
        included: {},
        bundleSplit: "price_ratio",
        bundleFallback: "even",
        regularUnitPrices: { [a.variantId!]: "1500", [b.variantId!]: "500" },
      },
    });
    const result = resolveBundles(
      o,
      catalog(
        product(a.variantId!, { regularUnitPrice: 1000n }),
        product(b.variantId!, { regularUnitPrice: 1000n }),
      ),
      settings({ bundleSplit: "price_ratio" }),
    );
    expect(result.sale.lines.map((l) => l.exTax)).toEqual([1500n, 500n]);
  });

  it("refuses a malformed sale-time price rather than guess", () => {
    const a = line({ group: group("G") });
    const o = order({
      lines: [a],
      saleContext: {
        included: {},
        bundleSplit: "price_ratio",
        bundleFallback: "even",
        regularUnitPrices: { [a.variantId!]: "12.50" },
      },
    });
    expect(() =>
      resolveBundles(o, catalog(product(a.variantId!)), settings()),
    ).toThrow(/regular unit price/);
  });
});
