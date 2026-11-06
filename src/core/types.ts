// The DTOs the pure core is built against. The Medusa edge (the order reader)
// maps query.graph results into these; nothing in src/core sees a Medusa
// shape.

// Re-exported rather than redeclared so there is exactly one Minor alias in the
// core: two identical aliases would be interchangeable today but could drift.
export type { Minor } from "./money";
import type { Minor } from "./money";

/** ISO 4217, upper case. */
export type Currency = string;

export interface CoreOrder {
  /** Platform order id. */
  id: string;
  /** ISO instant with offset: when the sale counts as paid. */
  paidAt: string;
  /** Sale (presentment) currency. */
  currency: Currency;
  financialStatus: "paid" | "partially_refunded" | "refunded" | "other";
  test: boolean;
  /** true: line amounts include tax (subtract recorded tax); false: they exclude it. */
  taxesIncluded: boolean;
  lines: CoreLine[];
  /** After shipping discounts, same tax basis as lines. */
  shipping: { amount: Minor; tax: Minor };
  /** Actual card fee as a ratio, settlement currency (never converted); null = unknown. */
  fee: { fee: Minor; charge: Minor } | null;
  /**
   * The payment provider that took the charge ("pp_stripe_stripe", "paypal"),
   * named when its order falls back to the flat fee. Absent or null:
   * not recorded.
   */
  gateway?: string | null;
  refunds: CoreRefund[];
  /**
   * What the customer was charged in all, tax included, when the platform
   * records it (Medusa: the captured amount). Refunds reaching it are a full
   * return. Absent: the lines and shipping are summed, which can differ from
   * the charge by the rounding of each line.
   */
  chargedTotal?: Minor | null;
  /**
   * ISO instant the order was cancelled after payment (Medusa's
   * `canceled_at`), or absent/null. Read only when unlined refunds are
   * inferred (BuildSnapshotInput.unlinedRefunds "infer"): a cancellation
   * is then a full return at this instant of whatever the refunds dated on
   * or before it left. A Medusa cancellation after capture
   * also writes a full refund a moment before it, which completes the
   * return first, so the cancellation then adds nothing.
   */
  cancelledAt?: string | null;
  /**
   * What the sale was built with, recorded by the ledger when a live push of
   * the sale's period was accepted (captureSaleContext). Absent or
   * null: the current product config and settings are used.
   *
   * It applies to every refund of the order built in another period, so a
   * refund mirrors the sale that was sent even after the product was
   * (un)ticked, the split setting changed or catalog prices moved. For the
   * sale's own period it applies only once frozen (saleContextFrozen): until
   * then that period may be pushed again and must pick up the publisher's
   * corrections (see saleViewOf).
   */
  saleContext?: SaleContext | null;
  /**
   * true once the context can no longer change: RHQ imported the sale's
   * period, or a refund of the order went out in another period's accepted
   * snapshot (and so mirrored this context).
   */
  saleContextFrozen?: boolean;
}

export interface SaleContext {
  /**
   * Inclusion per variant id the sale used, unticked and unconfigured ones
   * (false) included, so exclusion is recorded as firmly as inclusion. A
   * variant not listed falls back to current config.
   */
  included: Record<string, boolean>;
  bundleSplit: BundleSplit;
  bundleFallback: BundleFallback;
  /**
   * Regular unit price per variant id a bundle split read, as an integer
   * count of minor units in a string ("1250" for £12.50), so it round-trips
   * through JSON without a float; null when the price was unknown (the split
   * fell back), so a price added later cannot re-weight the refund. A variant
   * not listed falls back to its current catalog price.
   */
  regularUnitPrices: Record<string, string | null>;
}

export interface CoreLine {
  id: string;
  /** Platform variant id. */
  variantId: string | null;
  productId: string | null;
  title: string;
  sku: string | null;
  barcode: string | null;
  /** Integer units (a count, not money). */
  quantity: number;
  /** Price per unit before discounts, same tax basis as the order. */
  originalUnitPrice: Minor;
  /** Sum of the discounts allocated to the line (line + order level). */
  discountTotal: Minor;
  /** Tax recorded on the line (sum of taxLines). */
  tax: Minor;
  isGiftCard: boolean;
  requiresShipping: boolean;
  /**
   * A grouped bundle the line was sold in. Medusa
   * has none, so its reader leaves this null and bundles are manual
   * compositions only.
   */
  group: {
    id: string;
    title: string;
    quantity: number;
    variantId: string | null;
  } | null;
  /** Order-time regular price when recorded, for price_ratio; else null (catalog price used). */
  regularUnitPrice: Minor | null;
}

export interface CoreRefundLine {
  lineId: string;
  quantity: number;
  /** On the order's tax basis. */
  amount: Minor;
  tax: Minor;
}

export interface CoreRefund {
  id: string;
  /** ISO instant. */
  createdAt: string;
  lines: CoreRefundLine[];
  shipping: { amount: Minor; tax: Minor };
  /**
   * Money refunded outside lines and shipping (an unlined refund):
   * the cash that went back, TAX INCLUDED whatever the order's tax basis,
   * positive when more was refunded
   * than lines and shipping account for. Absent means none. Never a refund
   * row: it lowers the sale while the sale's period has not gone out, and
   * is otherwise ignored for royalties and reported.
   */
  unallocatedAmount?: Minor;
}

/** From the plugin's variant settings + catalog, keyed by variant id. */
export interface ProductConfig {
  variantId: string;
  included: boolean;
  rhqProductId: string | null;
  /** Value from the configured ISBN source, resolved at the edge (identity/pickIsbnSource). */
  isbnSourceValue: string | null;
  sku: string | null;
  asin: string | null;
  title: string;
  /** Current catalog price, same currency as the order, or null. */
  regularUnitPrice: Minor | null;
  /** Manual composition. */
  bundleComponents: { variantId: string; quantity: number }[] | null;
}

export type CardFeeMode = "none" | "actual" | "flat";
export type BundleSplit = "platform_allocation" | "price_ratio" | "even";
export type BundleFallback = "price_ratio" | "even";
/** Automatic pushes on the schedule; manual waits for a person. */
export type PushMode = "automatic" | "manual";

export interface CoreSettings {
  /** "15", "12.5"; null = none. */
  commissionPercent: string | null;
  cardFeeMode: CardFeeMode;
  flatFeePercent: string | null;
  /** Double-deduction guard: user confirmed commission does NOT cover card fees. */
  commissionExcludesFeesConfirmed: boolean;
  includeShipping: boolean;
  bundleSplit: BundleSplit;
  /** Used when platform_allocation's guard fails. */
  bundleFallback: BundleFallback;
  /** 1..12 */
  frequencyMonths: number;
  /** 1..12 */
  anchorMonth: number;
  /** 1..28 */
  pushDay: number;
  /** Store IANA zone. */
  timezone: string;
  /** Store country. */
  saleCountry: string;
  pushMode: PushMode;
}
