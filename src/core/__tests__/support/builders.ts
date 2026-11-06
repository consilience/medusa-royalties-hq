import type {
  CoreLine,
  CoreOrder,
  CoreRefund,
  CoreSettings,
} from "../../types";

// Small builders so each test states only the fields it is about; everything
// else is a neutral default (tax-exclusive, no discount, no fee, no shipping).

let lineSeq = 0;

export function line(overrides: Partial<CoreLine> = {}): CoreLine {
  lineSeq += 1;
  return {
    id: `line_${lineSeq}`,
    variantId: `${lineSeq}`,
    productId: `product_${lineSeq}`,
    title: `Book ${lineSeq}`,
    sku: null,
    barcode: null,
    quantity: 1,
    originalUnitPrice: 1000n,
    discountTotal: 0n,
    tax: 0n,
    isGiftCard: false,
    requiresShipping: true,
    group: null,
    regularUnitPrice: null,
    ...overrides,
  };
}

export function order(overrides: Partial<CoreOrder> = {}): CoreOrder {
  return {
    id: "order_1",
    paidAt: "2026-08-10T12:00:00+01:00",
    currency: "GBP",
    financialStatus: "paid",
    test: false,
    taxesIncluded: false,
    lines: [line()],
    shipping: { amount: 0n, tax: 0n },
    fee: null,
    refunds: [],
    ...overrides,
  };
}

/** A refund that returns every line and all shipping, exactly as sold. */
export function fullRefund(o: CoreOrder): CoreRefund {
  return {
    id: "refund_1",
    createdAt: "2026-08-12T12:00:00Z",
    lines: o.lines.map((l) => ({
      lineId: l.id,
      quantity: l.quantity,
      amount: l.originalUnitPrice * BigInt(l.quantity) - l.discountTotal,
      tax: l.tax,
    })),
    shipping: { ...o.shipping },
  };
}

export const settings = (
  overrides: Partial<CoreSettings> = {},
): CoreSettings => ({
  commissionPercent: null,
  cardFeeMode: "none",
  flatFeePercent: null,
  commissionExcludesFeesConfirmed: false,
  includeShipping: false,
  bundleSplit: "price_ratio",
  bundleFallback: "even",
  frequencyMonths: 1,
  anchorMonth: 1,
  pushDay: 15,
  timezone: "Europe/London",
  saleCountry: "GB",
  pushMode: "automatic",
  ...overrides,
});
