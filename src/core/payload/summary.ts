import { formatDecimal } from "../money";
import {
  addTo,
  type AggregateResult,
  type MoneyTotals,
} from "../rows/aggregate";
import type { UnmatchedRefund } from "../rows/attribution";
import type { MoneyByCurrency, SummaryV1 } from "./types";

/** Money totals as `{ CUR: "decimal" }`, keys sorted so the hash is stable. */
export function moneyByCurrency(totals: MoneyTotals): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const currency of [...totals.keys()].sort()) {
    out[currency] = formatDecimal(totals.get(currency)!, currency);
  }
  return out;
}

export interface SummaryInput {
  ordersIncluded: number;
  ordersExcluded: number;
  refundsIncluded: number;
  aggregate: AggregateResult;
  unmatchedRefunds: readonly UnmatchedRefund[];
  bundleSplitFallbacks: number;
  unknownBundleLines: number;
  feeFallbackOrders: number;
  flatFeeMissingOrders: number;
  unallocatedShipping: { sales: MoneyTotals; refunds: MoneyTotals };
  manualComponentsMissing: number;
  netsClamped: number;
  lateRefunds: { count: number; byCurrency: MoneyTotals };
  lateSales: { count: number; byCurrency: MoneyTotals };
  refundsOnUnpaidOrders?: number;
  ignoredMoneyOnly: { count: number; byCurrency: MoneyTotals };
  /** Counts from reading unlined refunds (unlinedRefunds "infer"); absent otherwise. */
  unlinedRefunds?: {
    inferred: number;
    ambiguous: number;
    afterFullReturn: number;
  };
}

/**
 * The snapshot summary. Built as one object literal so
 * the key order is fixed; canonicalJson sorts keys for the hash anyway, but a
 * stable literal order keeps logs and fixtures readable.
 */
export function buildSummary(input: SummaryInput): SummaryV1 {
  const agg = input.aggregate;
  const unmatchedAmount: MoneyTotals = new Map();
  for (const u of input.unmatchedRefunds) {
    addTo(unmatchedAmount, u.currency, u.amount);
  }

  const summary: SummaryV1 = {
    orders_included: input.ordersIncluded,
    orders_excluded: input.ordersExcluded,
    refunds_included: input.refundsIncluded,
    unticked_product_lines: agg.unticked.lines,
    unticked_revenue: moneyByCurrency(agg.unticked.revenue),
    unmatched_refunds: {
      count: input.unmatchedRefunds.length,
      by_currency: moneyByCurrency(unmatchedAmount),
    },
    bundle_split_fallbacks: input.bundleSplitFallbacks,
    unknown_bundle_lines: input.unknownBundleLines,
    invalid_isbns: agg.invalidIsbnVariants.length,
    lines_without_identifier: {
      count: agg.withoutIdentifier.count,
      revenue: moneyByCurrency(agg.withoutIdentifier.revenue),
      refunds: moneyByCurrency(agg.withoutIdentifier.refunds),
    },
    fee_fallback_orders: input.feeFallbackOrders,
  };

  // Optional keys: rare conditions, shown only when they happened, so the
  // common summary stays short for the reviewer.
  const { sales: shipSales, refunds: shipRefunds } = input.unallocatedShipping;
  if ([...shipSales.values(), ...shipRefunds.values()].some((v) => v !== 0n)) {
    summary.unallocated_shipping = {
      sales: moneyByCurrency(shipSales),
      refunds: moneyByCurrency(shipRefunds),
    };
  }
  if (input.flatFeeMissingOrders > 0) {
    summary.flat_fee_missing_orders = input.flatFeeMissingOrders;
  }
  if (input.manualComponentsMissing > 0) {
    summary.manual_components_missing = input.manualComponentsMissing;
  }
  if (agg.untickedRefunds.lines > 0) {
    summary.unticked_refund_lines = agg.untickedRefunds.lines;
    summary.unticked_refund_revenue = moneyByCurrency(
      agg.untickedRefunds.revenue,
    );
  }
  if (input.lateRefunds.count > 0) {
    summary.late_refunds = {
      count: input.lateRefunds.count,
      by_currency: moneyByCurrency(input.lateRefunds.byCurrency),
    };
  }
  if (input.lateSales.count > 0) {
    summary.late_sales = {
      count: input.lateSales.count,
      by_currency: moneyByCurrency(input.lateSales.byCurrency),
    };
    // The count under its own key; late_sales stays for its amounts.
    summary.orders_reported_late = input.lateSales.count;
  }
  if ((input.refundsOnUnpaidOrders ?? 0) > 0) {
    summary.refunds_on_unpaid_orders = input.refundsOnUnpaidOrders;
  }
  if (input.ignoredMoneyOnly.count > 0) {
    summary.ignored_money_only_refunds = {
      count: input.ignoredMoneyOnly.count,
      by_currency: moneyByCurrency(input.ignoredMoneyOnly.byCurrency),
    };
  }
  const unlined = input.unlinedRefunds;
  if (unlined !== undefined && unlined.inferred > 0) {
    summary.refunds_inferred_from_amount = unlined.inferred;
  }
  if (unlined !== undefined && unlined.ambiguous > 0) {
    summary.ambiguous_refund_amounts = unlined.ambiguous;
  }
  if (unlined !== undefined && unlined.afterFullReturn > 0) {
    summary.refunds_after_full_return = unlined.afterFullReturn;
  }
  if (input.netsClamped > 0) {
    summary.nets_clamped = input.netsClamped;
  }
  if (agg.tooLongVariants.length > 0) {
    summary.identifiers_too_long = agg.tooLongVariants.length;
  }
  if (agg.refundsWithoutUnits.count > 0) {
    summary.refunds_without_units = {
      count: agg.refundsWithoutUnits.count,
      moved_to_sales: moneyByCurrency(agg.refundsWithoutUnits.movedToSales),
      not_sent: moneyByCurrency(agg.refundsWithoutUnits.notSent),
    };
  }
  return summary;
}
