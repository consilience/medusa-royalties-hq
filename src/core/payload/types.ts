// Wire shapes of RHQ's snapshot API. Field names are snake_case on purpose:
// these objects are serialised as they are, so a rename here is a breaking
// change to what RHQ receives. Money is always a decimal string in major
// units, never a JSON number.

import type { Identifiers } from "../identity";
import type { BundleSplit, CardFeeMode } from "../types";

/** Decimal string in major units of the row's currency, e.g. "187.43", "-13.39", "1500". */
export type MoneyString = string;
/** Percentage string 0–100, e.g. "8.5000". */
export type PercentString = string;
/** { "GBP": "12.00", "JPY": "1500" }, keys sorted. */
export type MoneyByCurrency = Record<string, MoneyString>;

/**
 * Sales-side detail behind a row, all ex tax.
 * There is deliberately no `tax` key: RHQ refuses one even when null.
 */
export interface BreakdownV1 {
  /** Ex tax, before discount: royalty_on_sales = gross − discount − commission − fees + shipping. */
  gross: MoneyString;
  discount: MoneyString;
  shipping: MoneyString;
  fees: MoneyString;
  commission: MoneyString;
}

export interface SnapshotRowV1 {
  identifiers: Identifiers;
  title: string | null;
  sale_country: string;
  currency: string;
  units_sold: number;
  royalty_on_sales: MoneyString;
  units_refunded: number;
  royalty_on_refunds: MoneyString;
  list_price: MoneyString | null;
  discount_percent: PercentString | null;
  /** null for a row with no sales in the period (refunds only). */
  breakdown: BreakdownV1 | null;
}

export interface SnapshotSettingsV1 {
  commission_percent: PercentString | null;
  card_fee_mode: CardFeeMode;
  include_shipping: boolean;
  bundle_split: BundleSplit;
  frequency_months: number;
  push_day: number;
  refund_cutoff_at: string;
  /**
   * Recorded by RHQ so a month's figures can be explained later.
   * push_mode is the store's setting, not how this month was sent:
   * a re-push must not change the bytes.
   * fee_gateway_fallbacks names the gateways whose orders had no recorded
   * fee, so the flat rate was used.
   */
  push_mode: "automatic" | "manual";
  card_fee_flat_percent: PercentString | null;
  commission_excludes_fees_confirmed: boolean;
  fee_gateway_fallbacks: string[];
}

/**
 * Free-form in the API; these keys are what this client sends.
 * The first eleven are always present so a reviewer
 * sees an explicit zero; the optional ones appear only when non-empty.
 */
export interface SummaryV1 {
  orders_included: number;
  orders_excluded: number;
  /** Refunds attributed to this period (cut-off rule), whichever month they were sold in. */
  refunds_included: number;
  unticked_product_lines: number;
  /** Ex-tax revenue of unticked lines, by currency. */
  unticked_revenue: MoneyByCurrency;
  unmatched_refunds: {
    count: number;
    /**
     * Refunded amounts as recorded, on the (unknown) order's tax basis,
     * positive. The tax beside them is not sent: RHQ drops amounts under
     * tax-named summary keys.
     */
    by_currency: MoneyByCurrency;
  };
  /** Bundles split by the fallback method (one per bundle, however many notes it raised). */
  bundle_split_fallbacks: number;
  unknown_bundle_lines: number;
  /** Distinct products whose ISBN source value is not a valid ISBN (sent without an ISBN). */
  invalid_isbns: number;
  lines_without_identifier: {
    count: number;
    /** Ex-tax revenue of the sale lines held back, by currency. */
    revenue: MoneyByCurrency;
    /** Ex-tax amount of the refund lines held back (≤ 0), by currency. */
    refunds: MoneyByCurrency;
  };
  fee_fallback_orders: number;
  /** Shipping ex tax no royalty line could carry, sale (≥ 0) and refund (≤ 0) sides apart so they cannot cancel. */
  unallocated_shipping?: {
    sales: MoneyByCurrency;
    refunds: MoneyByCurrency;
  };
  flat_fee_missing_orders?: number;
  manual_components_missing?: number;
  /** Refund lines of products not included (at sale time when recorded, else now): held back, never sent. */
  unticked_refund_lines?: number;
  /** Ex-tax amount of those refund lines (≤ 0), by currency. */
  unticked_refund_revenue?: MoneyByCurrency;
  /** Refunds captured after the period they belong to was committed, booked into this one; net booked (≤ 0) by currency. */
  late_refunds?: { count: number; by_currency: MoneyByCurrency };
  /** Sales stored after the month they were paid in was committed, booked into this one; net booked by currency. */
  late_sales?: { count: number; by_currency: MoneyByCurrency };
  /** The same as late_sales.count: sales in this month paid in an earlier one. */
  orders_reported_late?: number;
  /** Refunds dated in the month on orders that never became a sale, so were not booked. */
  refunds_on_unpaid_orders?: number;
  /**
   * Money refunded outside lines and shipping (unlined refunds)
   * that was ignored for royalties: made after the sale's period was pushed
   * or its cut-off passed, or of an order not in the ledger. Gross as recorded, positive = money went back, by currency.
   */
  ignored_money_only_refunds?: { count: number; by_currency: MoneyByCurrency };
  /**
   * Refunds with no lines attributed to this period that were read as the
   * refund of the one line, shipping or gift card their amount names
   * (unlinedRefunds "infer").
   */
  refunds_inferred_from_amount?: number;
  /** Unlined refunds here whose amount matched two or more charges: spread pro rata instead. */
  ambiguous_refund_amounts?: number;
  /** Refunds dated in this period after their order's full return: they added nothing. */
  refunds_after_full_return?: number;
  /** Lines (sale or refund) whose card fee was cut back so commission + fee could not flip the royalty's sign. */
  nets_clamped?: number;
  identifiers_too_long?: number;
  refunds_without_units?: {
    count: number;
    /** Net netted into royalty_on_sales of a row that sold units (≤ 0). */
    moved_to_sales: MoneyByCurrency;
    /** Net that no row could carry, so it was not sent (≤ 0). */
    not_sent: MoneyByCurrency;
  };
}

export interface PayloadV1 {
  schema_version: 1;
  period: string;
  store_timezone: string;
  generated_at: string;
  client: { platform: "medusa"; version: string };
  settings: SnapshotSettingsV1;
  rows: SnapshotRowV1[];
  summary: SummaryV1;
  /**
   * Which store is pushing. Never set by the core: the edge adds it
   * just before sending, and only to an install that lists `store_id`.
   */
  store?: { id: string };
}

export type SnapshotWarningCode =
  | "invalid_isbn"
  | "identifier_too_long"
  | "line_without_identifier"
  | "bundle_split_fallback"
  | "unknown_bundle_line"
  | "manual_component_missing"
  | "fee_fallback"
  | "flat_fee_missing"
  | "unallocated_shipping"
  | "unmatched_refund"
  | "refund_without_units"
  | "net_clamped"
  | "late_refund"
  | "late_sale"
  | "money_only_refund_ignored"
  | "refund_inferred_from_amount"
  | "ambiguous_refund_amount"
  | "refund_after_full_return";

/**
 * Detail behind the summary counts, for the app's own UI and logs. Not sent
 * to RHQ: the summary is shown to a reviewer, and per-line lists could run to
 * thousands of entries in a large month.
 */
export interface SnapshotWarning {
  code: SnapshotWarningCode;
  orderId: string | null;
  /** The line, variant, bundle or refund the warning is about. */
  subject: string | null;
  message: string;
}

export interface RowCountError {
  code: "too_many_rows";
  rows: number;
  max: number;
}
