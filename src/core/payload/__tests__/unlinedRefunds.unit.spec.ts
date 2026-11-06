import {
  buildSnapshot,
  MAX_SNAPSHOT_ROWS,
  type BuildSnapshotInput,
} from "../../payload";
import type { CoreOrder, CoreRefund, ProductConfig } from "../../types";
import { line, order, settings } from "../../__tests__/support/builders";

// buildSnapshot with unlinedRefunds "infer" (the Medusa edge's setting): the
// rules for refunds with no lines (rows/unlined.ts) reach the
// rows, and the summary counts what was inferred.

function build(
  orders: CoreOrder[],
  unlinedRefunds?: BuildSnapshotInput["unlinedRefunds"],
) {
  const products = new Map<string, ProductConfig>();
  for (const o of orders) {
    for (const l of o.lines) {
      products.set(l.variantId!, {
        variantId: l.variantId!,
        included: true,
        rhqProductId: null,
        isbnSourceValue: null,
        sku: `SKU-${l.variantId!.split("/").pop()}`,
        asin: null,
        title: l.title,
        regularUnitPrice: null,
        bundleComponents: null,
      });
    }
  }
  return buildSnapshot({
    period: "2026-08",
    orders,
    orphanRefunds: [],
    products,
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
    ...(unlinedRefunds === undefined ? {} : { unlinedRefunds }),
  });
}

const unlined = (id: string, cash: bigint, createdAt: string): CoreRefund => ({
  id,
  createdAt,
  lines: [],
  shipping: { amount: 0n, tax: 0n },
  unallocatedAmount: cash,
});

// Sold in July; refunded on 20 August, after July's cut-off (15 August).
const julySale = (refunds: CoreRefund[], lines = [line({ quantity: 3 })]) =>
  order({ id: "order_july", paidAt: "2026-07-10T10:00:00Z", lines, refunds });

describe("buildSnapshot, unlinedRefunds", () => {
  it("by default, an unlined amount never returns units", () => {
    const o = julySale([unlined("r1", 1000n, "2026-08-20T10:00:00Z")]);
    const { payload } = build([o]);
    expect(payload.rows).toEqual([]);
    expect(payload.summary.ignored_money_only_refunds).toEqual({
      count: 1,
      by_currency: { GBP: "10.00" },
    });
  });

  it("infer: an amount of whole units after the cut-off is a refund with units", () => {
    const o = julySale([unlined("r1", 1000n, "2026-08-20T10:00:00Z")]);
    const { payload, pushedRefundIds } = build([o], "infer");
    expect(payload.rows).toMatchObject([
      { units_sold: 0, units_refunded: 1, royalty_on_refunds: "-10.00" },
    ]);
    expect(payload.summary.ignored_money_only_refunds).toBeUndefined();
    expect(payload.summary.refunds_inferred_from_amount).toBe(1);
    expect(pushedRefundIds).toEqual(["r1"]);
  });

  it("infer: an ambiguous amount is spread, never matched again on the effective lines", () => {
    // 10.00 is one unit of A (2 × 10.00) and the whole of B: ambiguous on
    // the order's lines, so it is spread 20 : 10. The plain spread
    // would see only B's 10.00 line as matching and take it all off
    // B.
    const a = line({ quantity: 2 });
    const b = line();
    const o = order({
      lines: [a, b],
      refunds: [unlined("r1", 1000n, "2026-08-20T10:00:00Z")],
    });
    const { payload } = build([o], "infer");
    expect(payload.rows.map((r) => [r.units_sold, r.royalty_on_sales])).toEqual(
      [
        [2, "13.33"],
        [1, "6.67"],
      ],
    );
    expect(payload.summary.ambiguous_refund_amounts).toBe(1);
  });

  it("infer: a cancellation by the cut-off leaves nothing of the sale", () => {
    const o = order({ cancelledAt: "2026-08-20T10:00:00Z" });
    const { payload } = build([o], "infer");
    expect(payload.rows).toEqual([]);
  });

  it("infer: a refund after a full return adds nothing and is counted in its month", () => {
    const o = julySale(
      [unlined("r2", 1000n, "2026-08-20T10:00:00Z")],
      [line()],
    );
    const cancelled = { ...o, cancelledAt: "2026-07-12T10:00:00Z" };
    const { payload, pushedRefundIds } = build([cancelled], "infer");
    expect(payload.rows).toEqual([]);
    expect(pushedRefundIds).toEqual([]);
    expect(payload.summary.refunds_after_full_return).toBe(1);
  });

  it("infer: leaves the new summary keys out when nothing was inferred", () => {
    const { payload } = build([order()], "infer");
    expect(payload.summary).not.toHaveProperty("refunds_inferred_from_amount");
    expect(payload.summary).not.toHaveProperty("ambiguous_refund_amounts");
    expect(payload.summary).not.toHaveProperty("refunds_after_full_return");
  });
});
