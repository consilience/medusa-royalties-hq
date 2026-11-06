import {
  buildSnapshot,
  canonicalJson,
  MAX_SNAPSHOT_ROWS,
  type BuildSnapshotInput,
} from "../../payload";
import type {
  CoreLine,
  CoreOrder,
  CoreSettings,
  ProductConfig,
} from "../../types";
import { payloadErrors } from "../../__tests__/support/wireChecks";
import { line, order, settings } from "../../__tests__/support/builders";

// Behaviour beyond the end-to-end fixtures: the RHQ sign rules, the row cap,
// titles, summary edge cases and determinism.

function product(
  variantId: string,
  overrides: Partial<ProductConfig> = {},
): ProductConfig {
  return {
    variantId,
    included: true,
    rhqProductId: null,
    isbnSourceValue: null,
    sku: `SKU-${variantId.split("/").pop()}`,
    asin: null,
    title: `Product ${variantId}`,
    regularUnitPrice: null,
    bundleComponents: null,
    ...overrides,
  };
}

function productsFor(
  orders: CoreOrder[],
  extra: ProductConfig[] = [],
): Map<string, ProductConfig> {
  const m = new Map<string, ProductConfig>();
  for (const o of orders) {
    for (const l of o.lines) {
      if (l.variantId !== null && !m.has(l.variantId)) {
        m.set(l.variantId, product(l.variantId));
      }
    }
  }
  for (const p of extra) m.set(p.variantId, p);
  return m;
}

function build(
  orders: CoreOrder[],
  opts: Omit<Partial<BuildSnapshotInput>, "settings"> & {
    settings?: Partial<CoreSettings>;
  } = {},
) {
  const { settings: s, ...rest } = opts;
  return buildSnapshot({
    period: "2026-08",
    orders,
    orphanRefunds: [],
    products: productsFor(orders),
    settings: settings(s ?? {}),
    recordedCutoffs: new Map(),
    committedPeriods: new Set(),
    refundsAlreadyPushed: new Map(),
    moneyOnlyRefundsAlreadyReported: new Map(),
    appliedMoneyOnlyRefundIds: new Map(),
    ordersAlreadyPushed: new Map(),
    generatedAt: "2026-09-20T02:00:00Z",
    clientVersion: "0.1.0",
    maxRows: MAX_SNAPSHOT_ROWS,
    ...rest,
  });
}

describe("refund money with no refunded units", () => {
  // RHQ refuses royalty_on_refunds < 0 with units_refunded = 0, and a row
  // with neither units sold nor refunded fails its units rule. A goodwill or
  // price-adjustment refund (money, no quantity) must still never produce
  // such a row.

  it("nets both into the sale when made by its cut-off: one with units, one without", () => {
    const l = line({ quantity: 2 });
    const o = order({
      lines: [l],
      refunds: [
        {
          id: "r1",
          createdAt: "2026-08-12T12:00:00Z",
          lines: [{ lineId: l.id, quantity: 1, amount: 1000n, tax: 0n }],
          shipping: { amount: 0n, tax: 0n },
        },
        {
          id: "r2",
          createdAt: "2026-08-13T12:00:00Z",
          lines: [{ lineId: l.id, quantity: 0, amount: 150n, tax: 0n }],
          shipping: { amount: 0n, tax: 0n },
        },
      ],
    });
    const { payload } = build([o]);
    expect(payload.rows).toHaveLength(1);
    // 2 × 10.00 sold, one returned for 10.00 and 1.50 given back.
    expect(payload.rows[0]).toMatchObject({
      units_sold: 1,
      royalty_on_sales: "8.50",
      units_refunded: 0,
      royalty_on_refunds: "0.00",
    });
    expect(payload.summary.refunds_without_units).toBeUndefined();
    expect(payloadErrors(payload)).toEqual([]);
  });

  it("is netted into royalty_on_sales by its sale's cut-off, as any refund is", () => {
    const l = line({ quantity: 2 });
    const o = order({
      lines: [l],
      refunds: [
        {
          id: "r1",
          createdAt: "2026-08-13T12:00:00Z",
          lines: [{ lineId: l.id, quantity: 0, amount: 150n, tax: 0n }],
          shipping: { amount: 0n, tax: 0n },
        },
      ],
    });
    const { payload } = build([o]);
    expect(payload.rows[0]).toMatchObject({
      units_sold: 2,
      royalty_on_sales: "18.50",
      units_refunded: 0,
      royalty_on_refunds: "0.00",
    });
    // Nothing was moved: it never was a refund row.
    expect(payload.summary.refunds_without_units).toBeUndefined();
    expect(payloadErrors(payload)).toEqual([]);
  });

  it("is reported and not sent when the row would have no units at all", () => {
    const l = line({ quantity: 1 });
    const o = order({
      paidAt: "2026-07-10T12:00:00+01:00",
      lines: [l],
      refunds: [
        {
          id: "r1",
          createdAt: "2026-08-20T12:00:00Z",
          lines: [{ lineId: l.id, quantity: 0, amount: 150n, tax: 0n }],
          shipping: { amount: 0n, tax: 0n },
        },
      ],
    });
    const { payload, warnings } = build([o]);
    expect(payload.rows).toEqual([]);
    expect(payload.summary.refunds_without_units).toEqual({
      count: 1,
      moved_to_sales: {},
      not_sent: { GBP: "-1.50" },
    });
    expect(warnings.map((w) => w.code)).toContain("refund_without_units");
    expect(payloadErrors(payload)).toEqual([]);
  });
});

describe("row cap", () => {
  it(`reports more than ${MAX_SNAPSHOT_ROWS} rows as an error and never truncates`, () => {
    const lines: CoreLine[] = Array.from(
      { length: MAX_SNAPSHOT_ROWS + 1 },
      () => line(),
    );
    const o = order({ lines });
    const result = build([o]);
    expect(result.payload.rows).toHaveLength(MAX_SNAPSHOT_ROWS + 1);
    expect(result.rowCountError).toEqual({
      code: "too_many_rows",
      rows: MAX_SNAPSHOT_ROWS + 1,
      max: MAX_SNAPSHOT_ROWS,
    });
  });

  it("allows exactly the cap", () => {
    const lines = Array.from({ length: MAX_SNAPSHOT_ROWS }, () => line());
    expect(build([order({ lines })]).rowCountError).toBeUndefined();
  });

  it("takes the install's own cap when the caller has one (api.limits.max_rows)", () => {
    // Installs are upgraded one by one, so the cap is read per install; the
    // default is only for one whose handshake predates api.limits.
    const lines = Array.from({ length: 3 }, () => line());
    expect(build([order({ lines })], { maxRows: 2 }).rowCountError).toEqual({
      code: "too_many_rows",
      rows: 3,
      max: 2,
    });
    expect(
      build([order({ lines })], { maxRows: 3 }).rowCountError,
    ).toBeUndefined();
  });

  it("takes an install cap above the fallback too", () => {
    const lines = Array.from({ length: MAX_SNAPSHOT_ROWS + 1 }, () => line());
    expect(
      build([order({ lines })], { maxRows: MAX_SNAPSHOT_ROWS + 1 })
        .rowCountError,
    ).toBeUndefined();
  });

  it("requires the cap: the caller must decide it, not inherit a default", () => {
    // The cap comes from the handshake (api.limits.max_rows); the edge passes
    // MAX_SNAPSHOT_ROWS itself only for an install whose handshake lacks it.
    // Checked by tsc: the expect-error fails the typecheck if maxRows turns
    // optional again.
    const input: Omit<BuildSnapshotInput, "maxRows"> = {
      period: "2026-08",
      orders: [],
      orphanRefunds: [],
      products: new Map(),
      settings: settings(),
      recordedCutoffs: new Map(),
      committedPeriods: new Set(),
      refundsAlreadyPushed: new Map(),
      moneyOnlyRefundsAlreadyReported: new Map(),
      appliedMoneyOnlyRefundIds: new Map(),
      ordersAlreadyPushed: new Map(),
      generatedAt: "2026-09-20T02:00:00Z",
      clientVersion: "0.1.0",
    };
    // @ts-expect-error maxRows is required
    const withoutCap: BuildSnapshotInput = input;
    expect(withoutCap).toBe(input);
  });
});

describe("client", () => {
  it("names the platform medusa", () => {
    expect(build([]).payload.client).toEqual({
      platform: "medusa",
      version: "0.1.0",
    });
  });
});

describe("titles", () => {
  it("strips control characters and caps at 1000 characters", () => {
    const long = "é".repeat(1005);
    const a = line({ title: "Tab\there\u0000 and\r\nnewline" });
    const b = line({ title: long });
    const { payload } = build([order({ lines: [a, b] })]);
    const titles = payload.rows.map((r) => r.title);
    expect(titles).toContain("Tabhere andnewline");
    expect(titles).toContain("é".repeat(1000));
  });

  it("sends null for a title that is blank once cleaned", () => {
    const { payload } = build([
      order({ lines: [line({ title: " \u0007 " })] }),
    ]);
    expect(payload.rows[0]!.title).toBeNull();
  });

  it("takes the latest paid line's title for a merged row", () => {
    const v = "77";
    const early = order({
      id: "o1",
      paidAt: "2026-08-02T12:00:00+01:00",
      lines: [line({ variantId: v, title: "Old title" })],
    });
    const late = order({
      id: "o2",
      paidAt: "2026-08-20T12:00:00+01:00",
      lines: [line({ variantId: v, title: "New title" })],
    });
    // Input order must not matter: the later paid date wins.
    const { payload } = build([late, early]);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]!.title).toBe("New title");
  });

  it("names a manual bundle's component by its product, not the bundle line", () => {
    const bundle = line({
      variantId: "500",
      title: "Legacy Box Set",
      originalUnitPrice: 2000n,
    });
    const o = order({ lines: [bundle] });
    const products = productsFor(
      [o],
      [
        product("500", {
          included: false,
          bundleComponents: [
            { variantId: "501", quantity: 1 },
          ],
        }),
        product("501", { title: "Book One" }),
      ],
    );
    const { payload } = build([o], { products });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]!.title).toBe("Book One");
    expect(payload.rows[0]!.royalty_on_sales).toBe("20.00");
  });
});

describe("identifiers", () => {
  it("sends an override as the only identifier", () => {
    const l = line({ variantId: "42" });
    const o = order({ lines: [l] });
    const products = productsFor(
      [o],
      [
        product("42", {
          rhqProductId: "RHQ-9",
          isbnSourceValue: "9781402894626",
          sku: "X",
        }),
      ],
    );
    const { payload } = build([o], { products });
    expect(payload.rows[0]!.identifiers).toEqual({
      rhq_product_id: "RHQ-9",
      isbn: null,
      sku: null,
      asin: null,
      store_product_id: "42",
    });
  });

  it("merges two variants that resolve to the same identifiers", () => {
    const a = line({ variantId: "1" });
    const b = line({ variantId: "2" });
    const o = order({ lines: [a, b] });
    const products = productsFor(
      [o],
      [
        product("1", { sku: "SAME" }),
        product("2", { sku: "SAME" }),
      ],
    );
    const { payload } = build([o], { products });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]!.units_sold).toBe(2);
  });

  it("counts refund lines of a product with no identifier", () => {
    const l = line({ variantId: "3" });
    const o = order({
      paidAt: "2026-07-10T12:00:00+01:00",
      lines: [l],
      refunds: [
        {
          id: "r",
          createdAt: "2026-08-20T12:00:00Z",
          lines: [{ lineId: l.id, quantity: 1, amount: 1000n, tax: 0n }],
          shipping: { amount: 0n, tax: 0n },
        },
      ],
    });
    const products = productsFor(
      [o],
      [product("3", { sku: null })],
    );
    const { payload } = build([o], { products });
    expect(payload.rows).toEqual([]);
    expect(payload.summary.lines_without_identifier).toEqual({
      count: 1,
      revenue: {},
      refunds: { GBP: "-10.00" },
    });
  });
});

describe("discount and list price", () => {
  it("is 100% when the whole line was discounted away", () => {
    const l = line({ originalUnitPrice: 1000n, discountTotal: 1000n });
    const { payload } = build([order({ lines: [l] })]);
    expect(payload.rows[0]).toMatchObject({
      royalty_on_sales: "0.00",
      list_price: "10.00",
      discount_percent: "100.0000",
    });
    expect(payload.rows[0]!.breakdown).toMatchObject({
      gross: "10.00",
      discount: "10.00",
    });
  });

  it("takes a fully discounted tax-inclusive line's discount ex tax by the order's ratio", () => {
    // The free line records no tax, so it has no ratio of its own; the
    // order's other line (12.00 incl, 2.00 tax) supplies 10/12.
    const priced = line({ originalUnitPrice: 1200n, tax: 200n });
    const free = line({ originalUnitPrice: 1200n, discountTotal: 1200n });
    const { payload } = build([
      order({ taxesIncluded: true, lines: [priced, free] }),
    ]);
    const freeRow = payload.rows.find((r) => r.royalty_on_sales === "0.00")!;
    expect(freeRow.breakdown).toMatchObject({
      gross: "10.00",
      discount: "10.00",
    });
    // The list price borrows the same order ratio, so the free copy is a
    // 100% discount rather than missing from discount_percent.
    expect(freeRow.list_price).toBe("10.00");
    expect(freeRow.discount_percent).toBe("100.0000");
  });

  it("leaves list price and discount null when no price is known", () => {
    // A manual component with no catalog price has no list price.
    const bundle = line({
      variantId: "600",
      originalUnitPrice: 1000n,
    });
    const o = order({ lines: [bundle] });
    const products = productsFor(
      [o],
      [
        product("600", {
          included: false,
          bundleComponents: [
            { variantId: "601", quantity: 1 },
          ],
        }),
        product("601"),
      ],
    );
    const { payload } = build([o], {
      products,
      settings: { bundleSplit: "even" },
    });
    expect(payload.rows[0]).toMatchObject({
      list_price: null,
      discount_percent: null,
    });
  });
});

describe("summary", () => {
  it("counts a bundle whose guard failed and whose fallback fell back again once", () => {
    const group = {
      id: "group_1",
      title: "Set",
      quantity: 1,
      variantId: null,
    };
    const a = line({ originalUnitPrice: 2000n, group });
    const b = line({ originalUnitPrice: 0n, group });
    const o = order({ lines: [a, b] });
    const { payload, warnings } = build([o], {
      settings: {
        bundleSplit: "platform_allocation",
        bundleFallback: "price_ratio",
      },
    });
    // No regular prices are known, so price_ratio falls back to even: two
    // notes about one bundle.
    expect(payload.summary.bundle_split_fallbacks).toBe(1);
    expect(
      warnings.filter((w) => w.code === "bundle_split_fallback"),
    ).toHaveLength(1);
  });

  it("reports shipping with no line to carry it", () => {
    const gift = line({ isGiftCard: true });
    const o = order({ lines: [gift], shipping: { amount: 450n, tax: 0n } });
    const { payload } = build([o], { settings: { includeShipping: true } });
    expect(payload.summary.unallocated_shipping).toEqual({
      sales: { GBP: "4.50" },
      refunds: {},
    });
  });

  it("reports unallocated sale and refund shipping separately, so they cannot cancel out", () => {
    const gift = line({ isGiftCard: true });
    const o = order({
      lines: [gift],
      shipping: { amount: 450n, tax: 0n },
      refunds: [
        {
          id: "r1",
          createdAt: "2026-08-12T12:00:00Z",
          lines: [],
          shipping: { amount: 450n, tax: 0n },
        },
      ],
    });
    const { payload } = build([o], { settings: { includeShipping: true } });
    expect(payload.summary.unallocated_shipping).toEqual({
      sales: { GBP: "4.50" },
      refunds: { GBP: "-4.50" },
    });
  });

  it("deducts a shipping-only refund from the sale that carried the shipping", () => {
    // £10.00 + £5.00 shipping sold, £5.00 shipping refunded alone in the
    // same month: no unit came back, so the refund nets into the sale
    // and the author is paid on £10.00, not £15.00.
    const l = line({ originalUnitPrice: 1000n });
    const o = order({
      lines: [l],
      shipping: { amount: 500n, tax: 0n },
      refunds: [
        {
          id: "r1",
          createdAt: "2026-08-12T12:00:00Z",
          lines: [],
          shipping: { amount: 500n, tax: 0n },
        },
      ],
    });
    const { payload } = build([o], { settings: { includeShipping: true } });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      units_sold: 1,
      royalty_on_sales: "10.00",
      units_refunded: 0,
      royalty_on_refunds: "0.00",
    });
    expect(payload.summary.unallocated_shipping).toBeUndefined();
    // Netted by its sale's cut-off, so never a refund row.
    expect(payload.summary.refunds_without_units).toBeUndefined();
    expect(payloadErrors(payload)).toEqual([]);
  });

  it("counts unknown bundle lines", () => {
    const priced = line({ originalUnitPrice: 1000n });
    const free = line({ originalUnitPrice: 0n });
    const { payload } = build([order({ lines: [priced, free] })]);
    expect(payload.summary.unknown_bundle_lines).toBe(1);
  });

  it("builds a refund whose commission and actual fee exceed its value, and counts the clamp", () => {
    // A July sale refunded after July's cut-off, so the refund is booked
    // here as a refund (a refund by the cut-off would net into the sale).
    const l = line({ originalUnitPrice: 1000n });
    const o = order({
      paidAt: "2026-07-10T12:00:00+01:00",
      lines: [l],
      fee: { fee: 3n, charge: 100n },
      refunds: [
        {
          id: "r1",
          createdAt: "2026-08-20T12:00:00Z",
          lines: [{ lineId: l.id, quantity: 1, amount: 1000n, tax: 0n }],
          shipping: { amount: 0n, tax: 0n },
        },
      ],
    });
    const { payload } = build([o], {
      settings: {
        commissionPercent: "100",
        cardFeeMode: "actual",
        commissionExcludesFeesConfirmed: true,
      },
    });
    expect(payload.rows[0]).toMatchObject({
      units_refunded: 1,
      royalty_on_refunds: "0.00",
    });
    expect(payload.summary.nets_clamped).toBe(1);
    expect(payloadErrors(payload)).toEqual([]);
  });

  it("only includes optional keys when they have something to say", () => {
    const { payload } = build([order()]);
    expect(Object.keys(payload.summary)).toEqual([
      "orders_included",
      "orders_excluded",
      "refunds_included",
      "unticked_product_lines",
      "unticked_revenue",
      "unmatched_refunds",
      "bundle_split_fallbacks",
      "unknown_bundle_lines",
      "invalid_isbns",
      "lines_without_identifier",
      "fee_fallback_orders",
    ]);
  });

  it("carries no tax-named key and no key over 255 bytes, at any depth", () => {
    // RHQ drops amounts under tax-named summary keys
    // and refuses a key over 255 bytes.
    const l = line({ originalUnitPrice: 1000n });
    const unmatched = {
      orderId: "order_999",
      currency: "GBP",
      refund: {
        id: "r9",
        createdAt: "2026-08-20T12:00:00+01:00",
        lines: [
          {
            lineId: "line_999",
            quantity: 1,
            amount: 1200n,
            tax: 200n,
          },
        ],
        shipping: { amount: 0n, tax: 0n },
      },
    };
    const { payload } = build([order({ lines: [l] })], {
      orphanRefunds: [unmatched],
    });
    expect(payload.summary.unmatched_refunds.count).toBe(1);
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (value === null || typeof value !== "object") return;
      for (const [k, v] of Object.entries(value)) {
        keys.push(k);
        walk(v);
      }
    };
    walk(payload.summary);
    const taxWords = /(^|[^a-z])(tax|taxes|vat|gst)([^a-z]|$)/i;
    expect(keys.filter((k) => taxWords.test(k.replace(/_/g, " ")))).toEqual([]);
    expect(keys.filter((k) => Buffer.byteLength(k, "utf8") > 255)).toEqual([]);
  });
});

describe("refunds by the cut-off reduce the sale", () => {
  // A refund on or before the sale month's
  // cut-off is not a refund. It lowers units_sold and royalty_on_sales and
  // never produces units_refunded; a fully refunded order is omitted.
  const refund = (
    lines: { lineId: string; quantity: number; amount: bigint }[],
    createdAt = "2026-08-20T10:00:00Z",
  ) => ({
    id: "r1",
    createdAt,
    lines: lines.map((l) => ({ ...l, tax: 0n })),
    shipping: { amount: 0n, tax: 0n },
  });

  it("nets a partial refund into its sale: fewer units, less money, no refund", () => {
    const l = line({ quantity: 3, originalUnitPrice: 1000n });
    const o = order({
      lines: [l],
      refunds: [refund([{ lineId: l.id, quantity: 1, amount: 1000n }])],
    });
    const { payload } = build([o]);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      units_sold: 2,
      royalty_on_sales: "20.00",
      units_refunded: 0,
      royalty_on_refunds: "0.00",
      discount_percent: "0.0000",
    });
  });

  it("omits a fully refunded order", () => {
    const l = line({ quantity: 2, originalUnitPrice: 1000n });
    const o = order({
      lines: [l],
      refunds: [refund([{ lineId: l.id, quantity: 2, amount: 2000n }])],
    });
    expect(build([o]).payload.rows).toEqual([]);
  });

  it("takes a refund larger than its line off the order's other sales, pro rata", () => {
    // A 10.00 refunded 12.50; the
    // 2.50 comes off B 20.00 and C 10.00 by 2:1, 1.67 and 0.83.
    const a = line({
      id: "A",
      variantId: "1",
      originalUnitPrice: 1000n,
    });
    const b = line({
      id: "B",
      variantId: "2",
      originalUnitPrice: 2000n,
    });
    const c = line({
      id: "C",
      variantId: "3",
      originalUnitPrice: 1000n,
    });
    const o = order({
      lines: [a, b, c],
      refunds: [refund([{ lineId: "A", quantity: 1, amount: 1250n }])],
    });
    const rows = build([o]).payload.rows;
    expect(
      rows.map((r) => [
        r.identifiers.store_product_id,
        r.units_sold,
        r.royalty_on_sales,
      ]),
    ).toEqual([
      ["2", 1, "18.33"],
      ["3", 1, "9.17"],
    ]);
  });

  it("still books a refund after the cut-off in its own month", () => {
    const l = line({ quantity: 3, originalUnitPrice: 1000n });
    const o = order({
      paidAt: "2026-07-20T10:00:00+01:00",
      lines: [l],
      refunds: [refund([{ lineId: l.id, quantity: 1, amount: 1000n }])],
    });
    const { payload } = build([o]);
    expect(payload.rows[0]).toMatchObject({
      units_sold: 0,
      units_refunded: 1,
      royalty_on_refunds: "-10.00",
    });
  });
});

describe("refunds and product inclusion", () => {
  const refundOf = (l: CoreLine, createdAt = "2026-08-12T12:00:00Z") => ({
    id: "r1",
    createdAt,
    lines: [{ lineId: l.id, quantity: 1, amount: 1000n, tax: 0n }],
    shipping: { amount: 0n, tax: 0n },
  });

  it("accounts a refund of a product that is unticked, never drops it silently", () => {
    // Sold in July, refunded after July's cut-off: a refund booked here.
    const l = line({ originalUnitPrice: 1000n });
    const o = order({
      paidAt: "2026-07-10T12:00:00+01:00",
      lines: [l],
      refunds: [refundOf(l, "2026-08-20T12:00:00Z")],
    });
    const { payload } = build([o], {
      products: productsFor([o], [product(l.variantId!, { included: false })]),
    });
    expect(payload.rows).toEqual([]);
    expect(payload.summary.unticked_refund_lines).toBe(1);
    expect(payload.summary.unticked_refund_revenue).toEqual({ GBP: "-10.00" });
  });

  it("sends the refund of a product ticked at sale but unticked now", () => {
    // Sold in July while ticked (and sent then); unticked since. The August
    // refund must still reverse July's sale.
    const l = line({ originalUnitPrice: 1000n });
    const o = order({
      paidAt: "2026-07-10T12:00:00+01:00",
      lines: [l],
      refunds: [refundOf(l, "2026-08-20T12:00:00Z")],
      saleContext: {
        included: { [l.variantId!]: true },
        bundleSplit: "price_ratio",
        bundleFallback: "even",
        regularUnitPrices: {},
      },
    });
    const { payload } = build([o], {
      products: productsFor([o], [product(l.variantId!, { included: false })]),
    });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      units_refunded: 1,
      royalty_on_refunds: "-10.00",
    });
    expect(payload.summary.unticked_refund_lines).toBeUndefined();
  });

  it("does not send the refund of a product unticked at sale but ticked now", () => {
    // July's sale was never sent; reversing it would claw back royalty the
    // author was never paid.
    const l = line({ originalUnitPrice: 1000n });
    const o = order({
      paidAt: "2026-07-10T12:00:00+01:00",
      lines: [l],
      refunds: [refundOf(l, "2026-08-20T12:00:00Z")],
      saleContext: {
        included: { [l.variantId!]: false },
        bundleSplit: "price_ratio",
        bundleFallback: "even",
        regularUnitPrices: {},
      },
    });
    const { payload } = build([o]);
    expect(payload.rows).toEqual([]);
    expect(payload.summary.unticked_refund_lines).toBe(1);
    expect(payload.summary.unticked_refund_revenue).toEqual({ GBP: "-10.00" });
  });
});

describe("sale context: what the build used, and when a recorded one applies", () => {
  const refundOf = (l: CoreLine, createdAt: string) => ({
    id: `r-${l.id}`,
    createdAt,
    lines: [{ lineId: l.id, quantity: 1, amount: 1000n, tax: 0n }],
    shipping: { amount: 0n, tax: 0n },
  });
  const excluding = (variantId: string) => ({
    included: { [variantId]: false },
    bundleSplit: "price_ratio" as const,
    bundleFallback: "even" as const,
    regularUnitPrices: {},
  });

  it("returns the context each sale was built with, and none for an order only refunded here", () => {
    const sold = line({ originalUnitPrice: 1000n });
    const unticked = line({ originalUnitPrice: 500n });
    const saleOrder = order({ id: "o-sale", lines: [sold, unticked] });
    const julyLine = line({ originalUnitPrice: 1000n });
    const refundOnly = order({
      id: "o-july",
      paidAt: "2026-07-10T12:00:00+01:00",
      lines: [julyLine],
      refunds: [refundOf(julyLine, "2026-08-20T12:00:00Z")],
    });
    const { capturedSaleContexts, refundedOrdersSoldElsewhere } = build(
      [saleOrder, refundOnly],
      {
        products: productsFor(
          [saleOrder, refundOnly],
          [product(unticked.variantId!, { included: false })],
        ),
        settings: { bundleSplit: "even" },
      },
    );
    expect([...capturedSaleContexts.keys()]).toEqual(["o-sale"]);
    // The July order's refund went out mirroring its sale's context, so an
    // accepted live push of this payload freezes that context.
    expect(refundedOrdersSoldElsewhere).toEqual(["o-july"]);
    expect(capturedSaleContexts.get("o-sale")).toEqual({
      included: { [sold.variantId!]: true, [unticked.variantId!]: false },
      bundleSplit: "even",
      bundleFallback: "even",
      regularUnitPrices: {},
    });
  });

  it("builds a sale from current config when its recorded context is not frozen", () => {
    // Pushed once with the product unticked; the publisher saw it missing
    // in RHQ's staged import, ticked it and pushes the period again.
    const l = line({ originalUnitPrice: 1000n });
    const o = order({ lines: [l], saleContext: excluding(l.variantId!) });
    const { payload, capturedSaleContexts } = build([o]);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({ units_sold: 1 });
    expect(capturedSaleContexts.get(o.id)?.included).toEqual({
      [l.variantId!]: true,
    });
  });

  it("builds a sale from its frozen context whatever the config says now", () => {
    const l = line({ originalUnitPrice: 1000n });
    const o = order({
      lines: [l],
      saleContext: excluding(l.variantId!),
      saleContextFrozen: true,
    });
    const { payload, capturedSaleContexts } = build([o]);
    expect(payload.rows).toEqual([]);
    expect(payload.summary.unticked_product_lines).toBe(1);
    expect(capturedSaleContexts.get(o.id)).toEqual(excluding(l.variantId!));
  });

  it("mirrors a refund of another period's sale by that sale's recorded context, frozen or not", () => {
    const l = line({ originalUnitPrice: 1000n });
    const o = order({
      paidAt: "2026-07-10T12:00:00+01:00",
      lines: [l],
      refunds: [refundOf(l, "2026-08-20T12:00:00Z")],
      saleContext: excluding(l.variantId!),
    });
    const { payload } = build([o]);
    expect(payload.rows).toEqual([]);
    expect(payload.summary.unticked_refund_lines).toBe(1);
  });

  it("rebuilds a pushed sale identically from its captured context after the config changed", () => {
    const a = line({
      originalUnitPrice: 1000n,
      group: {
        id: "G",
        title: "Box",
        quantity: 1,
        variantId: "9999",
      },
    });
    const b = line({ originalUnitPrice: 1000n, group: a.group });
    const c = line({ originalUnitPrice: 800n });
    const o = order({ lines: [a, b, c] });
    const before = productsFor(
      [o],
      [
        product(a.variantId!, { regularUnitPrice: 3000n }),
        product(b.variantId!, { regularUnitPrice: 1000n }),
        product(c.variantId!, { included: false }),
      ],
    );
    const first = build([o], { products: before });

    const after = productsFor(
      [o],
      [
        product(a.variantId!, { regularUnitPrice: 1000n }),
        product(b.variantId!, { regularUnitPrice: 1000n }),
        product(c.variantId!, { included: true }),
      ],
    );
    const frozen = {
      ...o,
      saleContext: first.capturedSaleContexts.get(o.id)!,
      saleContextFrozen: true,
    };
    const again = build([frozen], {
      products: after,
      settings: { bundleSplit: "even" },
    });
    expect(again.payload.rows).toEqual(first.payload.rows);
    expect(again.payload.summary).toEqual(first.payload.summary);
  });
});

describe("discount_percent", () => {
  it("counts a free copy on a tax-inclusive order as a full discount", () => {
    // 2 × 12.00 incl. VAT of the same book, one given away: half the list
    // value was discounted.
    const variantId = "77";
    const paid = line({ variantId, originalUnitPrice: 1200n, tax: 200n });
    const free = line({
      variantId,
      originalUnitPrice: 1200n,
      discountTotal: 1200n,
    });
    const { payload } = build([
      order({ taxesIncluded: true, lines: [paid, free] }),
    ]);
    expect(payload.rows[0]).toMatchObject({
      units_sold: 2,
      list_price: "10.00",
      discount_percent: "50.0000",
    });
  });
});

describe("late-captured refunds", () => {
  it("books a refund captured after its committed month into this period and reports it", () => {
    // Sold 30 Jul; refunded 10 Aug (before July's 15 Aug cut-off), but only
    // captured after July's snapshot was imported.
    const l = line({ originalUnitPrice: 1000n });
    const o = order({
      paidAt: "2026-07-30T12:00:00+01:00",
      lines: [l],
      refunds: [
        {
          id: "r1",
          createdAt: "2026-08-10T12:00:00+01:00",
          lines: [{ lineId: l.id, quantity: 1, amount: 1000n, tax: 0n }],
          shipping: { amount: 0n, tax: 0n },
        },
      ],
    });
    const { payload, warnings } = build([o], {
      committedPeriods: new Set(["2026-07"]),
    });
    expect(payload.rows[0]).toMatchObject({
      units_refunded: 1,
      royalty_on_refunds: "-10.00",
    });
    expect(payload.summary.late_refunds).toEqual({
      count: 1,
      by_currency: { GBP: "-10.00" },
    });
    expect(warnings.map((w) => w.code)).toContain("late_refund");
    expect(payloadErrors(payload)).toEqual([]);
  });
});

describe("money-only refunds (unallocatedAmount)", () => {
  // Refund money tied to no line is spread over everything the order charged, shipping
  // and gift cards included; only the books' shares lower royalties.
  const moneyBack = (amount: bigint) => ({
    id: "adj",
    createdAt: "2026-08-20T10:00:00Z",
    lines: [],
    shipping: { amount: 0n, tax: 0n },
    unallocatedAmount: amount,
  });
  const ab = () => {
    const a = line({
      id: "A",
      variantId: "1",
      originalUnitPrice: 1000n,
    });
    const b = line({
      id: "B",
      variantId: "2",
      originalUnitPrice: 2000n,
    });
    return order({
      lines: [a, b],
      shipping: { amount: 600n, tax: 0n },
      refunds: [moneyBack(700n)],
    });
  };
  const sales = (
    rows: {
      identifiers: { store_product_id: string | null };
      royalty_on_sales: string;
    }[],
  ) => rows.map((r) => [r.identifiers.store_product_id, r.royalty_on_sales]);

  it("spreads it over shipping too, and drops shipping's share when shipping is excluded (fixture amount-only-refund-with-shipping)", () => {
    // 700 by 1000:2000:600 → 194.44, 388.89, 116.67 → A 1.94, B 3.89,
    // shipping 1.17 (dropped).
    expect(sales(build([ab()]).payload.rows)).toEqual([
      ["1", "8.06"],
      ["2", "16.11"],
    ]);
  });

  it("takes shipping's share off the shipping the lines carry when shipping is included", () => {
    // Shipping 6.00 spread 1:2 → A 2.00, B 4.00; its 1.17 share comes off
    // that the same way, 0.39 and 0.78. A 10.00 − 1.94 + 2.00 − 0.39 = 9.67;
    // B 20.00 − 3.89 + 4.00 − 0.78 = 19.33. Together 29.00 = 36.00 − 7.00.
    expect(
      sales(
        build([ab()], { settings: { includeShipping: true } }).payload.rows,
      ),
    ).toEqual([
      ["1", "9.67"],
      ["2", "19.33"],
    ]);
  });

  // Before the sale's period is pushed, money refunded
  // outside lines and shipping lowers the sale itself; afterwards it is
  // ignored for royalties and only reported. August's cut-off is 15 Sep.
  const moneyOnly = (
    amount: bigint,
    createdAt = "2026-09-01T10:00:00+01:00",
    id = "m1",
  ) => ({
    id,
    createdAt,
    lines: [],
    shipping: { amount: 0n, tax: 0n },
    unallocatedAmount: amount,
  });

  it("lowers each sale line in proportion to its value before the period is pushed, units unchanged", () => {
    const a = line({ originalUnitPrice: 1000n });
    const b = line({ originalUnitPrice: 3000n });
    const o = order({ lines: [a, b], refunds: [moneyOnly(400n)] });
    const { payload, pushedRefundIds, appliedMoneyOnlyRefundIds } = build([o]);
    expect(payload.rows.map((r) => r.royalty_on_sales)).toEqual([
      "9.00",
      "27.00",
    ]);
    for (const row of payload.rows) {
      expect(row).toMatchObject({
        units_sold: 1,
        units_refunded: 0,
        royalty_on_refunds: "0.00",
      });
    }
    // Shown as a discount, so gross − discount still reconciles.
    expect(payload.rows[0]!.breakdown).toMatchObject({
      gross: "10.00",
      discount: "1.00",
    });
    expect(payload.summary.refunds_included).toBe(0);
    expect(payload.summary).not.toHaveProperty("ignored_money_only_refunds");
    // Recorded as applied (apart from refund rows), so a
    // re-push after the push keeps applying it.
    expect(appliedMoneyOnlyRefundIds).toEqual(["m1"]);
    expect(pushedRefundIds).toEqual([]);
    expect(payloadErrors(payload)).toEqual([]);
  });

  it("strips tax by the line's own ratio on a tax-inclusive order", () => {
    // 12.00 incl. 2.00 tax: 1.20 back is 1.00 ex tax.
    const l = line({ originalUnitPrice: 1200n, tax: 200n });
    const o = order({
      taxesIncluded: true,
      lines: [l],
      refunds: [moneyOnly(120n)],
    });
    expect(build([o]).payload.rows[0]!.royalty_on_sales).toBe("9.00");
  });

  it("strips tax from the cash on a tax-exclusive order too (the amount is tax-included cash)", () => {
    // 10.00 + 2.00 tax charged: 1.20 back is 1.00 ex tax, shown as 1.00
    // more discount so the breakdown still reconciles.
    const l = line({ originalUnitPrice: 1000n, tax: 200n });
    const o = order({ lines: [l], refunds: [moneyOnly(120n)] });
    const { payload } = build([o]);
    expect(payload.rows[0]).toMatchObject({
      royalty_on_sales: "9.00",
      breakdown: { gross: "10.00", discount: "1.00" },
    });
  });

  it("works in a zero-decimal currency", () => {
    const l = line({ originalUnitPrice: 1500n });
    const o = order({
      currency: "JPY",
      lines: [l],
      refunds: [moneyOnly(100n)],
    });
    expect(build([o]).payload.rows[0]!.royalty_on_sales).toBe("1400");
  });

  it("takes commission and fees off the adjustment, as it would off a refund", () => {
    const l = line({ originalUnitPrice: 1000n });
    const o = order({ lines: [l], refunds: [moneyOnly(100n)] });
    const { payload } = build([o], {
      settings: {
        commissionPercent: "10",
        cardFeeMode: "flat",
        flatFeePercent: "2",
        commissionExcludesFeesConfirmed: true,
      },
    });
    // 10.00 − 1.00 − 0.20 = 8.80 before; 9.00 − 0.90 − 0.18 = 7.92 after.
    expect(payload.rows[0]).toMatchObject({
      royalty_on_sales: "7.92",
      breakdown: { commission: "0.90", fees: "0.18" },
    });
  });

  it("weighs an unticked line in and drops its share", () => {
    const a = line({ originalUnitPrice: 1000n });
    const b = line({ originalUnitPrice: 1000n });
    const o = order({ lines: [a, b], refunds: [moneyOnly(200n)] });
    const products = productsFor(
      [o],
      [product(b.variantId!, { included: false })],
    );
    const { payload } = build([o], { products });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]!.royalty_on_sales).toBe("9.00");
  });

  it("lowers a bundle's components after the split, by each component's value", () => {
    const group = {
      id: "G",
      title: "Box",
      quantity: 1,
      variantId: "9999",
    };
    // Sold at 20.00 together; price_ratio 3:1 by regular price → 15.00 / 5.00.
    const a = line({ originalUnitPrice: 1000n, group });
    const b = line({ originalUnitPrice: 1000n, group });
    const o = order({ lines: [a, b], refunds: [moneyOnly(400n)] });
    const products = productsFor(
      [o],
      [
        product(a.variantId!, { regularUnitPrice: 3000n }),
        product(b.variantId!, { regularUnitPrice: 1000n }),
      ],
    );
    const { payload } = build([o], {
      products,
      settings: { bundleSplit: "price_ratio" },
    });
    expect(payload.rows.map((r) => r.royalty_on_sales)).toEqual([
      "12.00",
      "4.00",
    ]);
  });

  it("is ignored once the sale's period has been pushed, reported next month, and the staged period re-pushes byte-identical", () => {
    const l = line({ originalUnitPrice: 1000n });
    const before = order({ lines: [l] });
    const first = build([before]);
    const pushed = {
      recordedCutoffs: new Map([
        ["2026-08", first.payload.settings.refund_cutoff_at],
      ]),
      refundsAlreadyPushed: new Map([
        ["2026-08", new Set(first.pushedRefundIds)],
      ]),
      appliedMoneyOnlyRefundIds: new Map([
        ["2026-08", new Set(first.appliedMoneyOnlyRefundIds)],
      ]),
    };
    // Captured after August's push, though dated before its cut-off.
    const after = { ...before, refunds: [moneyOnly(250n)] };
    const again = build([after], pushed);
    expect(canonicalJson(again.payload)).toBe(canonicalJson(first.payload));
    expect(again.ignoredMoneyOnlyRefunds).toEqual([]);

    const sep = build([after], { ...pushed, period: "2026-09" });
    expect(sep.payload.rows).toEqual([]);
    expect(sep.payload.summary.ignored_money_only_refunds).toEqual({
      count: 1,
      by_currency: { GBP: "2.50" },
    });
    expect(sep.ignoredMoneyOnlyRefunds).toEqual([
      {
        orderId: after.id,
        refundId: "m1",
        currency: "GBP",
        amount: "2.50",
        createdAt: "2026-09-01T10:00:00+01:00",
        reason: "sale_period_pushed",
      },
    ]);
    expect(sep.reportedMoneyOnlyRefundIds).toEqual(["m1"]);
    expect(sep.warnings.map((w) => w.code)).toContain(
      "money_only_refund_ignored",
    );
    expect(payloadErrors(sep.payload)).toEqual([]);
  });

  // The history of what each push decided, as the push step
  // records it from an accepted live push of `period`.
  const historyAfter = (
    period: string,
    result: ReturnType<typeof build>,
    earlier: Partial<BuildSnapshotInput> = {},
  ): Partial<BuildSnapshotInput> => ({
    ...earlier,
    recordedCutoffs: new Map([
      ...(earlier.recordedCutoffs ?? []),
      [period, result.payload.settings.refund_cutoff_at],
    ]),
    refundsAlreadyPushed: new Map([
      ...(earlier.refundsAlreadyPushed ?? []),
      [period, new Set(result.pushedRefundIds)],
    ]),
    appliedMoneyOnlyRefundIds: new Map([
      ...(earlier.appliedMoneyOnlyRefundIds ?? []),
      [period, new Set(result.appliedMoneyOnlyRefundIds)],
    ]),
    moneyOnlyRefundsAlreadyReported: new Map([
      ...(earlier.moneyOnlyRefundsAlreadyReported ?? []),
      [period, new Set(result.reportedMoneyOnlyRefundIds)],
    ]),
  });

  it("treats the money-only part of a mixed refund the same on every re-push (B3)", () => {
    const l = line({ originalUnitPrice: 1000n, quantity: 2 });
    const before = order({ lines: [l] });
    const first = build([before]);
    // A refund with a line AND money-only money, dated before August's
    // cut-off but captured after August's first push.
    const mixed = {
      id: "mix",
      createdAt: "2026-09-01T10:00:00+01:00",
      lines: [{ lineId: l.id, quantity: 1, amount: 1000n, tax: 0n }],
      shipping: { amount: 0n, tax: 0n },
      unallocatedAmount: 250n,
    };
    const after = { ...before, refunds: [mixed] };
    const second = build([after], historyAfter("2026-08", first));
    // The line part nets into August; the money-only part came after the
    // push that sent the sale, so it is ignored, not applied.
    expect(second.pushedRefundIds).toEqual(["mix"]);
    expect(second.appliedMoneyOnlyRefundIds).toEqual([]);
    // The returned unit nets into the sale; the money-only
    // part does not lower it.
    expect(second.payload.rows[0]).toMatchObject({
      units_sold: 1,
      royalty_on_sales: "10.00",
    });

    const third = build([after], historyAfter("2026-08", second));
    expect(third.appliedMoneyOnlyRefundIds).toEqual([]);
    expect(canonicalJson(third.payload)).toBe(canonicalJson(second.payload));
    const fourth = build([after], historyAfter("2026-08", third));
    expect(canonicalJson(fourth.payload)).toBe(canonicalJson(second.payload));
  });

  it("keeps applying a mixed refund's money-only part that the push applied, and only that", () => {
    const l = line({ originalUnitPrice: 1000n, quantity: 2 });
    const mixed = {
      id: "mix",
      createdAt: "2026-09-01T10:00:00+01:00",
      lines: [{ lineId: l.id, quantity: 1, amount: 1000n, tax: 0n }],
      shipping: { amount: 0n, tax: 0n },
      unallocatedAmount: 250n,
    };
    const o = order({ lines: [l], refunds: [mixed] });
    const first = build([o]);
    expect(first.appliedMoneyOnlyRefundIds).toEqual(["mix"]);
    expect(first.pushedRefundIds).toEqual(["mix"]);
    const again = build([o], historyAfter("2026-08", first));
    expect(canonicalJson(again.payload)).toBe(canonicalJson(first.payload));
  });

  it("does not apply a mixed refund's money-only part because a later month carried its lines (B3, late in T)", () => {
    const l = line({ originalUnitPrice: 1000n, quantity: 2 });
    const before = order({ lines: [l] });
    const first = build([before]);
    const mixed = {
      id: "mix",
      createdAt: "2026-09-01T10:00:00+01:00",
      lines: [{ lineId: l.id, quantity: 1, amount: 1000n, tax: 0n }],
      shipping: { amount: 0n, tax: 0n },
      unallocatedAmount: 250n,
    };
    const after = { ...before, refunds: [mixed] };
    // August was imported before the refund was captured: its line part is
    // booked late into September, which is pushed.
    const augImported = {
      ...historyAfter("2026-08", first),
      committedPeriods: new Set(["2026-08"]),
    };
    const sep = build([after], { ...augImported, period: "2026-09" });
    expect(sep.pushedRefundIds).toEqual(["mix"]);
    const history = historyAfter("2026-09", sep, augImported);
    // August's import is undone; its re-push must not now apply the
    // money-only part just because September carried the refund's lines.
    const undone = { ...history, committedPeriods: new Set<string>() };
    const aug = build([after], undone);
    expect(aug.appliedMoneyOnlyRefundIds).toEqual([]);
    expect(canonicalJson(aug.payload)).toBe(canonicalJson(first.payload));
    const sepAgain = build([after], { ...undone, period: "2026-09" });
    expect(canonicalJson(sepAgain.payload)).toBe(canonicalJson(sep.payload));
  });

  it("is ignored after the sale period's cut-off", () => {
    const l = line({ originalUnitPrice: 1000n });
    const o = order({
      lines: [l],
      refunds: [moneyOnly(250n, "2026-09-20T10:00:00+01:00")],
    });
    expect(build([o]).payload.rows[0]!.royalty_on_sales).toBe("10.00");
    const sep = build([o], { period: "2026-09" });
    expect(sep.payload.summary.ignored_money_only_refunds).toEqual({
      count: 1,
      by_currency: { GBP: "2.50" },
    });
    expect(sep.ignoredMoneyOnlyRefunds[0]!.reason).toBe("after_cutoff");
  });

  it("ignores an orphan's money-only money and reports it", () => {
    const { payload } = build([], {
      orphanRefunds: [
        {
          orderId: "order_999",
          currency: "EUR",
          refund: moneyOnly(50n, "2026-08-20T10:00:00+01:00"),
        },
      ],
    });
    expect(payload.summary.ignored_money_only_refunds).toEqual({
      count: 1,
      by_currency: { EUR: "0.50" },
    });
    expect(payload.summary.unmatched_refunds.count).toBe(0);
  });
});

describe("late sales", () => {
  // Processed 28 Jul (a deferred-payment gateway), stored by reconciliation
  // only after July's snapshot was imported without it.
  const julyImported = {
    committedPeriods: new Set(["2026-07"]),
    ordersAlreadyPushed: new Map([["2026-07", new Set(["on-time"])]]),
  };
  const lateOrder = (refundAt?: string) => {
    const l = line({ originalUnitPrice: 1500n });
    return order({
      id: "late",
      paidAt: "2026-07-28T12:00:00+01:00",
      lines: [l],
      refunds:
        refundAt === undefined
          ? []
          : [
              {
                id: "r1",
                createdAt: refundAt,
                lines: [{ lineId: l.id, quantity: 1, amount: 1500n, tax: 0n }],
                shipping: { amount: 0n, tax: 0n },
              },
            ],
    });
  };

  it("books a sale paid after July was imported into August and reports it", () => {
    const o = lateOrder();
    const { payload, warnings, pushedOrderIds } = build([o], julyImported);
    expect(payload.rows[0]).toMatchObject({
      units_sold: 1,
      royalty_on_sales: "15.00",
    });
    expect(payload.summary.orders_included).toBe(1);
    expect(payload.summary.late_sales).toEqual({
      count: 1,
      by_currency: { GBP: "15.00" },
    });
    // The same count under its own key: sales in this month paid in
    // an earlier one.
    expect(payload.summary.orders_reported_late).toBe(1);
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "late_sale", orderId: "late" }),
    );
    // Recorded by the push step so August's re-push keeps it.
    expect(pushedOrderIds).toEqual(["late"]);
    expect(payloadErrors(payload)).toEqual([]);
  });

  it("counts late orders, not their lines", () => {
    const two = order({
      id: "late-two-lines",
      paidAt: "2026-07-30T12:00:00+01:00",
      lines: [line({ originalUnitPrice: 500n }), line({ originalUnitPrice: 700n })],
    });
    const { payload } = build([lateOrder(), two], julyImported);
    expect(payload.summary.late_sales?.count).toBe(2);
    expect(payload.summary.orders_reported_late).toBe(2);
  });

  it("sends its refund after August's cut-off in the refund's month", () => {
    const o = lateOrder("2026-09-20T12:00:00+01:00");
    const aug = build([o], julyImported);
    expect(aug.payload.rows[0]).toMatchObject({ units_refunded: 0 });
    const sep = build([o], { ...julyImported, period: "2026-09" });
    expect(sep.payload.rows[0]).toMatchObject({
      units_sold: 0,
      units_refunded: 1,
      royalty_on_refunds: "-15.00",
    });
    expect(sep.payload.summary).not.toHaveProperty("late_sales");
    expect(sep.payload.summary).not.toHaveProperty("orders_reported_late");
  });

  it("keeps it in July when July is not committed", () => {
    const o = lateOrder();
    const staged = { ordersAlreadyPushed: julyImported.ordersAlreadyPushed };
    const jul = build([o], { ...staged, period: "2026-07" });
    expect(jul.payload.rows[0]).toMatchObject({ units_sold: 1 });
    expect(jul.payload.summary).not.toHaveProperty("late_sales");
    expect(jul.payload.summary).not.toHaveProperty("orders_reported_late");
    expect(build([o], staged).payload.rows).toEqual([]);
  });
});

describe("determinism", () => {
  it("gives byte-identical canonical JSON whatever the input order", () => {
    const orders = [
      order({ id: "a", currency: "USD", lines: [line(), line()] }),
      order({ id: "b", currency: "EUR", lines: [line()] }),
      order({ id: "c", currency: "GBP", lines: [line(), line()] }),
    ];
    const products = productsFor(orders);
    const one = build(orders, { products });
    const two = build([...orders].reverse(), { products });
    expect(canonicalJson(one.payload)).toBe(canonicalJson(two.payload));
    expect(one.payload.rows.map((r) => r.currency)).toEqual([
      "EUR",
      "GBP",
      "GBP",
      "USD",
      "USD",
    ]);
  });

  it("canonicalJson sorts keys at every depth and has no whitespace", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [3, { f: null, e: "x" }], c: true } }),
    ).toBe('{"a":{"c":true,"d":[3,{"e":"x","f":null}]},"b":1}');
  });

  it("canonicalJson refuses values JSON cannot carry exactly", () => {
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: 0.5 })).toThrow();
  });
});

describe("input checks", () => {
  it("refuses invalid settings rather than build on them", () => {
    expect(() =>
      build([order()], { settings: { cardFeeMode: "flat" } }),
    ).toThrow(/flat_fee_percent_required/);
  });

  it("refuses a generated_at without an offset", () => {
    expect(() =>
      build([order()], { generatedAt: "2026-09-20 02:00:00" }),
    ).toThrow(/generatedAt/);
  });

  it("refuses an over-long client version", () => {
    expect(() => build([order()], { clientVersion: "x".repeat(51) })).toThrow(
      /clientVersion/,
    );
  });

  it("normalises the commission percent for the settings block", () => {
    const { payload } = build([order()], {
      settings: { commissionPercent: "12.50" },
    });
    expect(payload.settings.commission_percent).toBe("12.5");
  });

  it("records the fee settings and push mode RHQ stores", () => {
    const { payload } = build([order()], {
      settings: {
        cardFeeMode: "flat",
        flatFeePercent: "1.50",
        commissionPercent: "10",
        commissionExcludesFeesConfirmed: true,
      },
    });
    expect(payload.settings).toMatchObject({
      push_mode: "automatic",
      card_fee_flat_percent: "1.5",
      commission_excludes_fees_confirmed: true,
    });
    expect(payloadErrors(payload)).toEqual([]);

    const plain = build([order()]).payload.settings;
    expect(plain.card_fee_flat_percent).toBeNull();
    expect(plain.commission_excludes_fees_confirmed).toBe(false);
  });

  it("names the gateways whose orders fell back to the flat rate", () => {
    const actual = {
      cardFeeMode: "actual" as const,
      flatFeePercent: "2",
    };
    const { payload } = build(
      [
        order({ id: "o1", gateway: "paypal" }),
        order({ id: "o2", gateway: "paypal" }),
        order({ id: "o3", gateway: null }),
        order({
          id: "o4",
          gateway: "pp_example",
          fee: { fee: 30n, charge: 1000n },
        }),
      ],
      { settings: actual },
    );
    // Sorted, once each; an order with no gateway recorded is "unknown".
    expect(payload.settings.fee_gateway_fallbacks).toEqual([
      "paypal",
      "unknown",
    ]);
    expect(payloadErrors(payload)).toEqual([]);
  });

  it("sends an empty gateway list when no order fell back", () => {
    expect(build([order()]).payload.settings.fee_gateway_fallbacks).toEqual([]);
  });

  it("keeps gateway names within RHQ's limits: 50 names, 100 characters, no control characters", () => {
    const orders = Array.from({ length: 60 }, (_, i) =>
      order({ id: `o${i}`, gateway: `gw-${String(i).padStart(2, "0")}` }),
    );
    orders.push(order({ id: "long", gateway: `a\u0007${"b".repeat(150)}` }));
    const { payload } = build(orders, {
      settings: { cardFeeMode: "actual", flatFeePercent: "2" },
    });
    const names = payload.settings.fee_gateway_fallbacks;
    expect(names).toHaveLength(50);
    expect(
      names.every(
        (n) =>
          n.length <= 100 &&
          Array.from(n).every((c) => c.codePointAt(0)! > 0x1f),
      ),
    ).toBe(true);
    expect(payloadErrors(payload)).toEqual([]);
  });

  it("records the store's push mode setting", () => {
    expect(
      build([order()], { settings: { pushMode: "manual" } }).payload.settings
        .push_mode,
    ).toBe("manual");
  });

  it("uses the recorded cut-off for the settings block when the period was pushed", () => {
    const { payload } = build([order()], {
      recordedCutoffs: new Map([["2026-08", "2026-09-20T00:00:00+01:00"]]),
    });
    expect(payload.settings.refund_cutoff_at).toBe("2026-09-20T00:00:00+01:00");
  });
});

describe("refunds on orders that are no sale", () => {
  it("are counted in the summary, only when there are some", () => {
    expect(build([], { refundsOnUnpaidOrders: 2 }).payload.summary.refunds_on_unpaid_orders).toBe(2);
    // Absent at zero, so snapshots without any keep their exact bytes.
    expect(build([], { refundsOnUnpaidOrders: 0 }).payload.summary).not.toHaveProperty("refunds_on_unpaid_orders");
    expect(build([]).payload.summary).not.toHaveProperty("refunds_on_unpaid_orders");
  });
});
