import {
  captureSaleContext,
  resolveBundles,
  saleViewOf,
} from "../../bundles";
import type {
  CoreLine,
  CoreOrder,
  ProductConfig,
} from "../../types";
import { line, order, settings } from "../../__tests__/support/builders";

// captureSaleContext records what a snapshot build actually used for an
// order's sale, so a later build (a refund in another period, a re-push of
// a committed period) can resolve the order exactly as it was sent.

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

const V = (n: number) => `${n}`;

describe("captureSaleContext", () => {
  it("records the inclusion of every variant the sale used, unticked and unconfigured ones too", () => {
    const ticked = line({ variantId: V(1) });
    const unticked = line({ variantId: V(2) });
    const unknown = line({ variantId: V(3) });
    const custom = line({ variantId: null });
    const manual = line({ variantId: V(4) });
    const o = order({ lines: [ticked, unticked, unknown, custom, manual] });
    const products = catalog(
      product(V(1)),
      product(V(2), { included: false }),
      product(V(4), {
        included: false,
        bundleComponents: [
          { variantId: V(5), quantity: 1 },
          { variantId: V(6), quantity: 2 },
        ],
      }),
      product(V(5)),
    );

    const ctx = captureSaleContext(
      o,
      products,
      settings({ bundleSplit: "even", bundleFallback: "price_ratio" }),
    );

    // Exclusion is recorded as firmly as inclusion: a variant with no config
    // (V3, and the manual component V6) was left out of the sale, and must
    // stay left out of its refunds even if it is configured later.
    expect(ctx.included).toEqual({
      [V(1)]: true,
      [V(2)]: false,
      [V(3)]: false,
      [V(4)]: false,
      [V(5)]: true,
      [V(6)]: false,
    });
    expect(ctx.bundleSplit).toBe("even");
    expect(ctx.bundleFallback).toBe("price_ratio");
  });

  it("records the regular prices bundle splits read: the line's own, else the catalog's, null when unknown", () => {
    const own = line({ group: group("G"), regularUnitPrice: 1500n });
    const fromCatalog = line({ group: group("G") });
    const noPrice = line({ group: group("H") });
    const plain = line({ regularUnitPrice: 700n });
    const manual = line({ variantId: V(40) });
    const o = order({ lines: [own, fromCatalog, noPrice, plain, manual] });
    const products = catalog(
      product(own.variantId!, { regularUnitPrice: 9999n }),
      product(fromCatalog.variantId!, { regularUnitPrice: 500n }),
      product(noPrice.variantId!),
      product(plain.variantId!, { regularUnitPrice: 800n }),
      product(V(40), {
        bundleComponents: [
          { variantId: V(41), quantity: 1 },
          { variantId: V(42), quantity: 1 },
        ],
      }),
      product(V(41), { regularUnitPrice: 300n }),
      product(V(42), { regularUnitPrice: -5n }),
    );

    const ctx = captureSaleContext(o, products, settings());

    // A plain line's list price comes from the line itself, never from the
    // catalog, so it needs no entry. A negative catalog price is treated as
    // unknown by the split, so it is recorded as unknown.
    expect(ctx.regularUnitPrices).toEqual({
      [own.variantId!]: "1500",
      [fromCatalog.variantId!]: "500",
      [noPrice.variantId!]: null,
      [V(41)]: "300",
      [V(42)]: null,
    });
  });

  it("prefers the catalog price for a variant that is also a manual component, since that use read it", () => {
    const own = line({
      variantId: V(50),
      group: group("G"),
      regularUnitPrice: 1500n,
    });
    const other = line({ group: group("G"), regularUnitPrice: 100n });
    const manual = line({ variantId: V(51) });
    const o = order({ lines: [own, other, manual] });
    const products = catalog(
      product(V(50), { regularUnitPrice: 400n }),
      product(other.variantId!),
      product(V(51), {
        bundleComponents: [
          { variantId: V(50), quantity: 1 },
          { variantId: V(52), quantity: 1 },
        ],
      }),
      product(V(52), { regularUnitPrice: 100n }),
    );
    const ctx = captureSaleContext(o, products, settings());
    expect(ctx.regularUnitPrices[V(50)]).toBe("400");
  });

  it("returns an already recorded context unchanged rather than today's config", () => {
    const a = line({ group: group("G") });
    const b = line({ group: group("G") });
    const recorded = {
      included: { [a.variantId!]: true, [b.variantId!]: false },
      bundleSplit: "price_ratio" as const,
      bundleFallback: "even" as const,
      regularUnitPrices: { [a.variantId!]: "300", [b.variantId!]: null },
    };
    const o = order({ lines: [a, b], saleContext: recorded });
    const ctx = captureSaleContext(
      o,
      catalog(
        product(a.variantId!, { included: false, regularUnitPrice: 1n }),
        product(b.variantId!, { included: true, regularUnitPrice: 2n }),
      ),
      settings({ bundleSplit: "even" }),
    );
    expect(ctx).toEqual(recorded);
  });

  it("round-trips: resolving with the captured context after every config change gives the same lines", () => {
    // One order exercising everything the context carries: a ticked and an
    // unticked plain line, a grouped bundle split by price_ratio with one
    // component priced only in the catalog and one priced nowhere (so it
    // falls back to even), a grouped bundle split by catalog prices, and a
    // manual bundle, with a partial refund of each.
    const plainIn = line({ originalUnitPrice: 1200n });
    const plainOut = line({ originalUnitPrice: 900n });
    const g1 = line({ originalUnitPrice: 2000n, group: group("G1") });
    const g2 = line({ originalUnitPrice: 0n, group: group("G1") });
    const h1 = line({
      originalUnitPrice: 1000n,
      group: group("H"),
      regularUnitPrice: 1500n,
    });
    const h2 = line({ originalUnitPrice: 1000n, group: group("H") });
    const manual = line({ variantId: V(60), originalUnitPrice: 3000n });
    const lines = [plainIn, plainOut, g1, g2, h1, h2, manual];
    const o: CoreOrder = order({
      lines,
      refunds: [
        {
          id: "r1",
          createdAt: "2026-09-12T12:00:00Z",
          lines: lines.map((l) => ({
            lineId: l.id,
            quantity: 1,
            amount: l.originalUnitPrice / 2n,
            tax: 0n,
          })),
          shipping: { amount: 0n, tax: 0n },
        },
      ],
    });
    const before = catalog(
      product(plainIn.variantId!),
      product(plainOut.variantId!, { included: false }),
      product(g1.variantId!, { regularUnitPrice: 2500n }),
      product(g2.variantId!, { included: false }),
      product(h1.variantId!),
      product(h2.variantId!, { regularUnitPrice: 500n }),
      product(V(60), {
        included: false,
        bundleComponents: [
          { variantId: V(61), quantity: 1 },
          { variantId: V(62), quantity: 2 },
        ],
      }),
      product(V(61), { regularUnitPrice: 1000n }),
      product(V(62), { included: false, regularUnitPrice: 250n }),
    );
    const settingsBefore = settings({
      bundleSplit: "price_ratio",
      bundleFallback: "even",
    });
    const sent = resolveBundles(o, before, settingsBefore);
    const captured = captureSaleContext(o, before, settingsBefore);

    // Everything the context covers moves: every product ticked, every
    // catalog price changed (and the missing ones filled in), and the
    // split setting switched.
    const after = new Map<string, ProductConfig>(
      [...before].map(([id, p]) => [
        id,
        {
          ...p,
          included: true,
          regularUnitPrice: (p.regularUnitPrice ?? 0n) + 777n,
        },
      ]),
    );
    const settingsAfter = settings({
      bundleSplit: "platform_allocation",
      bundleFallback: "price_ratio",
    });

    expect(resolveBundles(o, after, settingsAfter)).not.toEqual(sent);
    expect(
      resolveBundles({ ...o, saleContext: captured }, after, settingsAfter),
    ).toEqual(sent);
  });
});

describe("saleViewOf", () => {
  const ctx = {
    included: {},
    bundleSplit: "even" as const,
    bundleFallback: "even" as const,
    regularUnitPrices: {},
  };

  it("drops a context that is not frozen: the sale's own period is built from current config", () => {
    const o = order({ saleContext: ctx });
    expect(saleViewOf(o).saleContext).toBeNull();
  });

  it("keeps a frozen context", () => {
    const o = order({ saleContext: ctx, saleContextFrozen: true });
    expect(saleViewOf(o)).toBe(o);
  });
});
