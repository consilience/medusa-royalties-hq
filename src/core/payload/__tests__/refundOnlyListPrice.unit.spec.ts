import { buildSnapshot, MAX_SNAPSHOT_ROWS } from "../../payload";
import type { CoreLine, CoreOrder, ProductConfig } from "../../types";
import { line, order, settings } from "../../__tests__/support/builders";

// list_price on a row with no sale in the period (refunds only).
// list_price is the product's regular price ex tax. A sold line falls back
// to its order-time price when no regular price is recorded,
// because it measures that line's discount; a refund-only row has no
// discount to measure (discount_percent stays null), so it reports a
// recorded regular price or nothing.

function product(
  variantId: string,
  overrides: Partial<ProductConfig> = {},
): ProductConfig {
  return {
    variantId,
    included: true,
    rhqProductId: null,
    isbnSourceValue: null,
    sku: `SKU-${variantId}`,
    asin: null,
    title: `Product ${variantId}`,
    regularUnitPrice: null,
    bundleComponents: null,
    ...overrides,
  };
}

function build(orders: CoreOrder[], products: ProductConfig[]) {
  return buildSnapshot({
    period: "2026-08",
    orders,
    orphanRefunds: [],
    products: new Map(products.map((p) => [p.variantId, p])),
    settings: settings(),
    recordedCutoffs: new Map(),
    committedPeriods: new Set(),
    refundsAlreadyPushed: new Map(),
    moneyOnlyRefundsAlreadyReported: new Map(),
    appliedMoneyOnlyRefundIds: new Map(),
    ordersAlreadyPushed: new Map(),
    generatedAt: "2026-09-20T02:00:00Z",
    clientVersion: "0.1.0",
    maxRows: MAX_SNAPSHOT_ROWS,
  });
}

// Sold in July, one unit refunded on 20 August (after July's cut-off), so
// August's row has refunds only.
function refundedInAugust(l: CoreLine, taxesIncluded = false): CoreOrder {
  return order({
    id: "july",
    paidAt: "2026-07-10T10:00:00Z",
    taxesIncluded,
    lines: [l],
    refunds: [
      {
        id: "r1",
        createdAt: "2026-08-20T10:00:00Z",
        lines: [
          {
            lineId: l.id,
            quantity: 1,
            amount: l.originalUnitPrice,
            tax: l.tax / BigInt(l.quantity),
          },
        ],
        shipping: { amount: 0n, tax: 0n },
      },
    ],
  });
}

describe("list_price on a refund-only row", () => {
  it("is the line's recorded regular price, with no discount_percent", () => {
    const l = line({
      variantId: "A",
      originalUnitPrice: 800n,
      regularUnitPrice: 1000n,
    });
    const { payload } = build([refundedInAugust(l)], [product("A")]);
    expect(payload.rows).toMatchObject([
      {
        units_sold: 0,
        units_refunded: 1,
        list_price: "10.00",
        discount_percent: null,
      },
    ]);
  });

  it("does not read today's catalog price for an ordinary line", () => {
    // A sale context records only the prices bundle splits read, so a
    // catalog price here would let a re-push of this month change with the
    // catalog.
    const l = line({ variantId: "A", originalUnitPrice: 800n });
    const { payload } = build(
      [refundedInAugust(l)],
      [product("A", { regularUnitPrice: 1200n })],
    );
    expect(payload.rows[0]).toMatchObject({
      list_price: null,
      discount_percent: null,
    });
  });

  it("is null when no regular price is recorded, never the price it sold at", () => {
    const l = line({ variantId: "A", originalUnitPrice: 800n });
    const { payload } = build([refundedInAugust(l)], [product("A")]);
    expect(payload.rows[0]).toMatchObject({
      list_price: null,
      discount_percent: null,
    });
  });

  it("is ex tax on a tax-inclusive order, by the line's recorded tax", () => {
    // 12.00 incl. 2.00 VAT; regular 12.00 incl. → 10.00 ex tax.
    const l = line({
      variantId: "A",
      originalUnitPrice: 1200n,
      tax: 200n,
      regularUnitPrice: 1200n,
    });
    const { payload } = build([refundedInAugust(l, true)], [product("A")]);
    expect(payload.rows[0]).toMatchObject({ list_price: "10.00" });
  });

  it("gives a manual bundle's components their regular prices", () => {
    const bundle = line({ variantId: "B", originalUnitPrice: 2000n });
    const { payload } = build(
      [refundedInAugust(bundle)],
      [
        product("B", {
          bundleComponents: [
            { variantId: "C1", quantity: 1 },
            { variantId: "C2", quantity: 1 },
          ],
        }),
        product("C1", { regularUnitPrice: 1000n }),
        product("C2", { regularUnitPrice: 1500n }),
      ],
    );
    expect(
      payload.rows.map((r) => [
        r.identifiers.sku,
        r.list_price,
        r.discount_percent,
      ]),
    ).toEqual([
      ["SKU-C1", "10.00", null],
      ["SKU-C2", "15.00", null],
    ]);
  });

  it("leaves a row that also sold in the period priced by its sales", () => {
    const old = line({
      variantId: "A",
      originalUnitPrice: 1000n,
      regularUnitPrice: 1500n,
    });
    const sold = line({ variantId: "A", originalUnitPrice: 1000n });
    const { payload } = build(
      [refundedInAugust(old), order({ id: "aug", lines: [sold] })],
      [product("A")],
    );
    expect(payload.rows[0]).toMatchObject({
      units_sold: 1,
      units_refunded: 1,
      list_price: "10.00",
      discount_percent: "0.0000",
    });
  });
});
