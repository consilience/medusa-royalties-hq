import type { Minor } from "../money";
import type { NetSettings } from "../rows/deductions";
import type { BundleFallback, BundleSplit, CoreSettings } from "../types";

/** The settings bundle resolution reads: the net steps plus the split choice. */
export type BundleSettings = NetSettings &
  Pick<CoreSettings, "bundleSplit" | "bundleFallback">;

/**
 * Which bundle an effective line came from. A grouped bundle (Medusa has
 * none) is known only by its group id, as there is
 * no parent line; a manual composition is known by the one real line that
 * was expanded.
 */
export type BundleRef =
  { kind: "group"; groupId: string } | { kind: "manual"; lineId: string };

export interface BundleInfo {
  ref: BundleRef;
  /** The method actually applied, after any fallback. */
  method: BundleSplit;
  /** Group title, or the manual bundle line's title, for reports. */
  title: string;
}

/**
 * One line as aggregation should see it, in minor units of the order
 * currency. For an ordinary line it is that line's net unchanged; for a
 * bundle component it is the component's share of the bundle.
 *
 * Invariant: net = exTax − commission − fees + shipping.
 */
export interface EffectiveLine {
  /** The real order line this stands for (a manual bundle's own line for its virtual components). */
  lineId: string;
  /** Real lines whose money was pooled to produce this line. */
  sourceLineIds: string[];
  variantId: string | null;
  /** Units sold (a count); for a manual component, component qty × line qty. */
  quantity: number;
  gross: Minor;
  discount: Minor;
  exTax: Minor;
  commission: Minor;
  fees: Minor;
  shipping: Minor;
  net: Minor;
  /**
   * Regular unit price excluding tax, for discount_percent. null only when no price is known; a tax-inclusive source with a
   * zero gross borrows the order's tax ratio (see split.ts listPriceExTax).
   */
  listPriceExTax: Minor | null;
  /** false: unticked (or unknown) product; the caller counts it as unticked revenue and never sends it. */
  included: boolean;
  bundle: BundleInfo | null;
}

/** One refunded line as aggregation should see it; money ≤ 0, units ≥ 0. */
export interface EffectiveRefundLine {
  lineId: string;
  sourceLineIds: string[];
  variantId: string | null;
  units: number;
  gross: Minor;
  exTax: Minor;
  commission: Minor;
  fees: Minor;
  shipping: Minor;
  net: Minor;
  /**
   * The regular unit price ex tax recorded for the sale (an ordinary
   * line's own; a bundle component's as its split read it), never the
   * order-time price: it is the list price of a row with refunds only,
   * which has no discount to measure. null or absent when none is
   * recorded.
   */
  listPriceExTax?: Minor | null;
  included: boolean;
  bundle: BundleInfo | null;
}

export interface EffectiveRefund {
  refundId: string;
  createdAt: string;
  lines: EffectiveRefundLine[];
  feeFallback: boolean;
  flatFeeMissing: boolean;
  unallocatedShipping: Minor;
  /** Real refund lines whose fee was cut back so the net kept its sign. */
  netsClamped: number;
}

export type BundleFallbackReason =
  /** platform_allocation guard: an included component at zero beside a priced one. */
  | "zero_priced_component"
  /** price_ratio: some component has no regular price (neither order-time nor catalog). */
  | "price_unknown"
  /** price_ratio: every component's regular price is zero. */
  | "prices_all_zero";

export interface BundleSplitFallback {
  ref: BundleRef;
  reason: BundleFallbackReason;
  /** The method the bundle was finally split with. */
  method: BundleFallback;
}

export interface UnknownBundleLine {
  lineId: string;
  variantId: string | null;
  title: string;
  quantity: number;
}

export interface MissingManualComponent {
  /** The manual bundle's line. */
  lineId: string;
  /** A component variant with no ProductConfig. */
  variantId: string;
}

export interface BundleNotes {
  /** → summary.bundle_split_fallbacks. A bundle may appear twice (guard failed, then its price_ratio fallback fell back again). */
  bundleSplitFallbacks: BundleSplitFallback[];
  /** → summary.unknown_bundle_lines. */
  unknownBundleLines: UnknownBundleLine[];
  /** Manual composition names a variant with no config: treated as unticked. */
  manualComponentsMissing: MissingManualComponent[];
}

export interface ResolvedOrder {
  orderId: string;
  sale: {
    lines: EffectiveLine[];
    feeFallback: boolean;
    flatFeeMissing: boolean;
    unallocatedShipping: Minor;
    /** Real sale lines whose fee was cut back so the net kept its sign. */
    netsClamped: number;
  };
  /** One per order refund, in the order's refund order. */
  refunds: EffectiveRefund[];
  notes: BundleNotes;
}
