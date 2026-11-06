import type {
  EffectiveLine,
  EffectiveRefund,
  EffectiveRefundLine,
} from "../bundles";
import {
  aggregationKey,
  resolveIdentifiers,
  type Identifiers,
  type ResolvedIdentifiers,
} from "../identity";
import { formatDecimal, mulDivRound, ratio, type Minor } from "../money";
import { toEpochMillis } from "../period";
import type { CoreLine, CoreOrder, Currency, ProductConfig } from "../types";
import type {
  BreakdownV1,
  SnapshotRowV1,
  SnapshotWarning,
} from "../payload/types";

/** Running money totals per currency (minor units of that currency). */
export type MoneyTotals = Map<Currency, Minor>;

export function addTo(totals: MoneyTotals, currency: Currency, amount: Minor) {
  totals.set(currency, (totals.get(currency) ?? 0n) + amount);
}

export interface SaleSource {
  order: CoreOrder;
  lines: readonly EffectiveLine[];
}

export interface RefundSource {
  order: CoreOrder;
  refund: EffectiveRefund;
}

export interface AggregateInput {
  /** Orders sold in the period, with their resolved (bundle-split) lines. */
  sales: readonly SaleSource[];
  /** Refunds attributed to the period, resolved against their own order. */
  refunds: readonly RefundSource[];
  products: ReadonlyMap<string, ProductConfig>;
  saleCountry: string;
}

export interface AggregateResult {
  /** Sorted by currency, then identifiers, then country. */
  rows: SnapshotRowV1[];
  unticked: { lines: number; revenue: MoneyTotals };
  /** Refund lines of products not included (at sale time when recorded); ex tax, ≤ 0. */
  untickedRefunds: { lines: number; revenue: MoneyTotals };
  withoutIdentifier: {
    count: number;
    revenue: MoneyTotals;
    refunds: MoneyTotals;
  };
  invalidIsbnVariants: string[];
  tooLongVariants: string[];
  refundsWithoutUnits: {
    count: number;
    movedToSales: MoneyTotals;
    notSent: MoneyTotals;
  };
  warnings: SnapshotWarning[];
}

/** Title cap from the API's SnapshotRow.title (maxLength counts code points). */
export const TITLE_MAX_LENGTH = 1000;

// C0, DEL and C1 controls: the API strips them anyway, so doing
// it here keeps the payload hash equal to what RHQ stores, and keeps a stray
// CR or tab out of the CSV export.
const CONTROL = /\p{Cc}/gu;

export function cleanTitle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.replace(CONTROL, "").trim();
  if (cleaned === "") return null;
  const chars = [...cleaned];
  // Truncated rather than dropped (unlike identifiers): a title is only for
  // the reviewer, so a shortened one misleads nobody, whereas a row with no
  // title at all is harder to review.
  return chars.length > TITLE_MAX_LENGTH
    ? chars.slice(0, TITLE_MAX_LENGTH).join("")
    : cleaned;
}

/**
 * A total order on contributions, so "the latest line" is the same whatever
 * order the ledger returned orders in: instant, then order id, then position.
 * Without the tie-breaks two lines paid in the same second would pick a
 * title (and so a payload hash) by accident.
 */
interface Rank {
  at: number;
  orderId: string;
  seq: number;
}

function isLater(a: Rank, b: Rank): boolean {
  if (a.at !== b.at) return a.at > b.at;
  if (a.orderId !== b.orderId) return a.orderId > b.orderId;
  return a.seq > b.seq;
}

interface Representative {
  rank: Rank;
  title: string;
  identifiers: Identifiers;
}

interface RowAcc {
  sortKey: string;
  currency: Currency;
  unitsSold: number;
  sales: Minor;
  unitsRefunded: number;
  refunds: Minor;
  /** Refund money that came with no refunded quantity (see finishRow). */
  zeroUnitRefunds: Minor;
  zeroUnitRefundLines: number;
  hasSales: boolean;
  gross: Minor;
  discount: Minor;
  shipping: Minor;
  fees: Minor;
  commission: Minor;
  listPrice: { units: number; rank: Rank; price: Minor } | null;
  /** The same over refunded lines: the list price of a row with no sales. */
  refundListPrice: { units: number; rank: Rank; price: Minor } | null;
  discountNumerator: Minor;
  discountDenominator: Minor;
  saleRep: Representative | null;
  refundRep: Representative | null;
}

function newRow(sortKey: string, currency: Currency): RowAcc {
  return {
    sortKey,
    currency,
    unitsSold: 0,
    sales: 0n,
    unitsRefunded: 0,
    refunds: 0n,
    zeroUnitRefunds: 0n,
    zeroUnitRefundLines: 0,
    hasSales: false,
    gross: 0n,
    discount: 0n,
    shipping: 0n,
    fees: 0n,
    commission: 0n,
    listPrice: null,
    refundListPrice: null,
    discountNumerator: 0n,
    discountDenominator: 0n,
    saleRep: null,
    refundRep: null,
  };
}

/**
 * The line's discount ex tax, for the breakdown.
 *
 * `discountTotal` is on the order's tax basis. On a tax-inclusive order it
 * contains tax, so it is scaled by the tax actually recorded: the line's own
 * exTax ÷ gross, which makes gross_ex − discount_ex equal the line's exTax
 * exactly (gross_ex is defined as exTax + discount_ex). A line discounted to
 * zero records no tax and so has no ratio; the order's overall exTax ÷ gross
 * stands in, since tax on one order is normally charged at one rate. If the
 * whole order is free there is no tax information at all and the discount is
 * used as recorded: nothing was paid, so no revenue is misstated by it.
 * Never a rate we would have to guess (tax is removed as recorded).
 */
function discountExTax(
  l: EffectiveLine,
  taxesIncluded: boolean,
  orderRatio: { exTax: Minor; gross: Minor },
): Minor {
  if (!taxesIncluded || l.discount === 0n) return l.discount;
  if (l.gross !== 0n) return mulDivRound(l.discount, l.exTax, l.gross);
  if (orderRatio.gross !== 0n) {
    return mulDivRound(l.discount, orderRatio.exTax, orderRatio.gross);
  }
  return l.discount;
}

/**
 * Title for an effective line: the real order line's title, except for a
 * manual bundle's virtual component, whose effective line points at the
 * bundle's own line; that title would name the box set on every component's
 * row, so the component product's title is used instead.
 */
function titleOf(
  eff: { lineId: string; variantId: string | null },
  lineById: ReadonlyMap<string, CoreLine>,
  products: ReadonlyMap<string, ProductConfig>,
): string {
  const real = lineById.get(eff.lineId);
  if (real !== undefined && real.variantId === eff.variantId) return real.title;
  const config =
    eff.variantId === null ? undefined : products.get(eff.variantId);
  return config?.title ?? real?.title ?? "";
}

/**
 * Aggregates effective sale and refund lines into snapshot rows.
 *
 * Key = identifiers (not variant) × sale_country × currency: variants that
 * resolve to the same identifiers are one RHQ product and must be one row,
 * and each currency is its own RHQ batch. Unticked lines never reach a
 * row; lines whose product has no usable identifier are held back and
 * reported, because the API refuses a row with none.
 */
export function aggregateRows(input: AggregateInput): AggregateResult {
  const rows = new Map<string, RowAcc>();
  const identifiersByVariant = new Map<string, ResolvedIdentifiers>();
  const invalidIsbn = new Set<string>();
  const tooLong = new Set<string>();
  const withoutIdentifierVariants = new Set<string>();
  const warnings: SnapshotWarning[] = [];

  const unticked = { lines: 0, revenue: new Map() as MoneyTotals };
  const untickedRefunds = { lines: 0, revenue: new Map() as MoneyTotals };
  const withoutIdentifier = {
    count: 0,
    revenue: new Map() as MoneyTotals,
    refunds: new Map() as MoneyTotals,
  };

  const resolve = (variantId: string, config: ProductConfig) => {
    let r = identifiersByVariant.get(variantId);
    if (r === undefined) {
      r = resolveIdentifiers(config, variantId);
      identifiersByVariant.set(variantId, r);
      if (r.warnings.includes("invalid_isbn")) {
        invalidIsbn.add(variantId);
        warnings.push({
          code: "invalid_isbn",
          orderId: null,
          subject: variantId,
          message: `"${config.title}" has an ISBN source value that is not a valid ISBN; sent without an ISBN.`,
        });
      }
      if (r.warnings.includes("identifier_too_long")) {
        tooLong.add(variantId);
        warnings.push({
          code: "identifier_too_long",
          orderId: null,
          subject: variantId,
          message: `"${config.title}" has an identifier longer than 255 characters; it was not sent.`,
        });
      }
    }
    return r;
  };

  // Returns the row for a line, or null when the line cannot be sent (and
  // has been counted as such).
  const rowFor = (
    variantId: string | null,
    currency: Currency,
    orderId: string,
  ): { row: RowAcc; identifiers: Identifiers } | null => {
    const config =
      variantId === null ? undefined : input.products.get(variantId);
    // resolveBundles marks a line with no config as not included, so callers
    // never get here without one; guard anyway rather than assert.
    if (variantId === null || config === undefined) return null;
    const resolved = resolve(variantId, config);
    if (!resolved.sendable) {
      if (!withoutIdentifierVariants.has(variantId)) {
        withoutIdentifierVariants.add(variantId);
        warnings.push({
          code: "line_without_identifier",
          orderId,
          subject: variantId,
          message: `"${config.title}" has no ISBN, SKU, ASIN or RHQ product id, so its lines were not sent.`,
        });
      }
      return null;
    }
    // Currency first, then identifiers, then country: the payload's sort
    // order. JSON of the tuple cannot collide.
    const sortKey = JSON.stringify([
      currency,
      aggregationKey(resolved.identifiers),
      input.saleCountry,
    ]);
    let row = rows.get(sortKey);
    if (row === undefined) {
      row = newRow(sortKey, currency);
      rows.set(sortKey, row);
    }
    return { row, identifiers: resolved.identifiers };
  };

  for (const { order, lines } of input.sales) {
    const currency = order.currency;
    const at = toEpochMillis(order.paidAt);
    const lineById = new Map(order.lines.map((l) => [l.id, l]));
    const orderRatio = { exTax: 0n, gross: 0n };
    for (const l of lines) {
      orderRatio.exTax += l.exTax;
      orderRatio.gross += l.gross;
    }

    lines.forEach((l, seq) => {
      if (!l.included) {
        // Excluded revenue must be visible, never silently lost.
        // Ex tax, before commission: what the customer paid for the product.
        unticked.lines += 1;
        addTo(unticked.revenue, currency, l.exTax);
        return;
      }
      const target = rowFor(l.variantId, currency, order.id);
      if (target === null) {
        withoutIdentifier.count += 1;
        addTo(withoutIdentifier.revenue, currency, l.exTax);
        return;
      }
      const { row, identifiers } = target;
      const rank: Rank = { at, orderId: order.id, seq };

      row.hasSales = true;
      row.unitsSold += l.quantity;
      row.sales += l.net;
      const discount = discountExTax(l, order.taxesIncluded, orderRatio);
      row.gross += l.exTax + discount;
      row.discount += discount;
      row.shipping += l.shipping;
      row.fees += l.fees;
      row.commission += l.commission;

      if (l.listPriceExTax !== null) {
        // Units-weighted over every sold line with a list
        // price, bundle-derived units included, so a contract on list price
        // minus discount sees what bundle buyers actually paid.
        row.discountNumerator += l.exTax;
        row.discountDenominator += l.listPriceExTax * BigInt(l.quantity);
        // The price of the line with the most units,
        // ties to the latest.
        const lp = row.listPrice;
        if (
          lp === null ||
          l.quantity > lp.units ||
          (l.quantity === lp.units && isLater(rank, lp.rank))
        ) {
          row.listPrice = { units: l.quantity, rank, price: l.listPriceExTax };
        }
      }

      if (row.saleRep === null || isLater(rank, row.saleRep.rank)) {
        row.saleRep = {
          rank,
          title: titleOf(l, lineById, input.products),
          identifiers,
        };
      }
    });
  }

  for (const { order, refund } of input.refunds) {
    const currency = order.currency;
    const at = toEpochMillis(refund.createdAt);
    const lineById = new Map(order.lines.map((l) => [l.id, l]));
    refund.lines.forEach((l: EffectiveRefundLine, seq) => {
      // An unticked product's sale was never sent, so neither is its refund.
      // It is still counted: if inclusion was judged on today's config (no
      // sale-time context recorded) the product may have been ticked when
      // sold, and the reviewer must be able to see the refund that was held
      // back rather than have it vanish.
      if (!l.included) {
        untickedRefunds.lines += 1;
        addTo(untickedRefunds.revenue, currency, l.exTax);
        return;
      }
      const target = rowFor(l.variantId, currency, order.id);
      if (target === null) {
        withoutIdentifier.count += 1;
        addTo(withoutIdentifier.refunds, currency, l.exTax);
        return;
      }
      const { row, identifiers } = target;
      if (l.units > 0) {
        row.unitsRefunded += l.units;
        row.refunds += l.net;
      } else if (l.net !== 0n) {
        row.zeroUnitRefunds += l.net;
        row.zeroUnitRefundLines += 1;
      }
      const rank: Rank = { at, orderId: `${order.id}#${refund.refundId}`, seq };
      const price = l.listPriceExTax ?? null;
      if (l.units > 0 && price !== null) {
        // As for sales: the line with the most units, ties to the latest.
        const lp = row.refundListPrice;
        if (
          lp === null ||
          l.units > lp.units ||
          (l.units === lp.units && isLater(rank, lp.rank))
        ) {
          row.refundListPrice = { units: l.units, rank, price };
        }
      }
      if (row.refundRep === null || isLater(rank, row.refundRep.rank)) {
        row.refundRep = {
          rank,
          title: titleOf(l, lineById, input.products),
          identifiers,
        };
      }
    });
  }

  const refundsWithoutUnits = {
    count: 0,
    movedToSales: new Map() as MoneyTotals,
    notSent: new Map() as MoneyTotals,
  };

  const out: { sortKey: string; row: SnapshotRowV1 }[] = [];
  for (const acc of rows.values()) {
    const row = finishRow(
      acc,
      input.saleCountry,
      refundsWithoutUnits,
      warnings,
    );
    if (row !== null) out.push({ sortKey: acc.sortKey, row });
  }
  // Plain code-unit comparison, not localeCompare: the order (and so the
  // payload hash) must not depend on the server's locale.
  out.sort((a, b) =>
    a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
  );

  return {
    rows: out.map((o) => o.row),
    unticked,
    untickedRefunds,
    withoutIdentifier,
    invalidIsbnVariants: [...invalidIsbn].sort(),
    tooLongVariants: [...tooLong].sort(),
    refundsWithoutUnits,
    warnings,
  };
}

/**
 * Turns an accumulator into a wire row, applying RHQ's sign rules.
 *
 * **Refund money with no refunded units.** RHQ refuses a row whose
 * royalty_on_refunds is negative while units_refunded is 0, and one with
 * neither units sold nor refunded. Such money arises from a goodwill or
 * price-adjustment refund (a refund line with quantity 0, or a re-weighted
 * bundle's quantity-less refund spread over components with zero units).
 * Inventing a refunded unit is not an option: per-unit contracts would claw
 * back a whole unit's royalty for a partial refund. So:
 *
 * 1. If the row has refunded units anyway, the money simply joins
 *    royalty_on_refunds (the rule is per row, and it is refund money).
 * 2. Else if the row sold units in the period, it is netted into
 *    royalty_on_sales. A price adjustment on this month's sale is a lower
 *    net for the units sold, which RHQ accepts even below zero (its
 *    "loss-making sale"). The breakdown stays sales-side, so it no longer
 *    reconciles to royalty_on_sales by that amount; the summary says so.
 * 3. Otherwise no row can carry it, and it is reported in
 *    `summary.refunds_without_units.not_sent` and not sent. That overpays
 *    the author by the adjustment until the publisher corrects it by hand,
 *    which is recoverable, whereas a rejected snapshot blocks the month.
 */
function finishRow(
  acc: RowAcc,
  saleCountry: string,
  refundsWithoutUnits: AggregateResult["refundsWithoutUnits"],
  warnings: SnapshotWarning[],
): SnapshotRowV1 | null {
  let sales = acc.sales;
  let refunds = acc.refunds;
  if (acc.zeroUnitRefunds !== 0n) {
    if (acc.unitsRefunded > 0) {
      refunds += acc.zeroUnitRefunds;
    } else if (acc.unitsSold > 0) {
      sales += acc.zeroUnitRefunds;
      refundsWithoutUnits.count += acc.zeroUnitRefundLines;
      addTo(
        refundsWithoutUnits.movedToSales,
        acc.currency,
        acc.zeroUnitRefunds,
      );
    } else {
      refundsWithoutUnits.count += acc.zeroUnitRefundLines;
      addTo(refundsWithoutUnits.notSent, acc.currency, acc.zeroUnitRefunds);
    }
  }

  const rep = acc.saleRep ?? acc.refundRep;
  if (acc.unitsSold === 0 && acc.unitsRefunded === 0) {
    // Only case 3 above leads here (every sale line has quantity ≥ 1).
    if (acc.zeroUnitRefunds !== 0n && rep !== null) {
      warnings.push({
        code: "refund_without_units",
        orderId: null,
        subject: rep.identifiers.store_product_id,
        message: `A refund of ${formatDecimal(-acc.zeroUnitRefunds, acc.currency)} ${acc.currency} on "${rep.title}" had no refunded units and no sale this period to net against, so it was not sent.`,
      });
    }
    return null;
  }
  if (rep === null) return null;

  const money = (m: Minor) => formatDecimal(m, acc.currency);
  const lp = acc.listPrice;
  const breakdown: BreakdownV1 | null = acc.hasSales
    ? {
        gross: money(acc.gross),
        discount: money(acc.discount),
        shipping: money(acc.shipping),
        fees: money(acc.fees),
        commission: money(acc.commission),
      }
    : null;

  const row: SnapshotRowV1 = {
    identifiers: rep.identifiers,
    title: cleanTitle(rep.title),
    sale_country: saleCountry,
    currency: acc.currency,
    units_sold: acc.unitsSold,
    royalty_on_sales: money(sales),
    units_refunded: acc.unitsRefunded,
    royalty_on_refunds: money(refunds),
    // A row with no sales has no discount to measure, so its list price
    // comes from the refunded lines and its discount_percent stays null.
    list_price:
      lp !== null
        ? money(lp.price)
        : acc.hasSales || acc.refundListPrice === null
          ? null
          : money(acc.refundListPrice.price),
    discount_percent:
      lp === null
        ? null
        : discountPercent(acc.discountNumerator, acc.discountDenominator),
    breakdown,
  };
  assertRowAcceptable(row, sales, refunds);
  return row;
}

/**
 * 1 − Σ exTax ÷ Σ (list price × units), as a 4 dp percent.
 * Clamped to 0–100 because the API's Percent refuses anything else: a
 * line sold above list (an inflated bundle component) is "no discount",
 * and a negative ex-tax total is "all discount". Null when there is nothing
 * to divide by (every list price zero).
 */
function discountPercent(numerator: Minor, denominator: Minor): string | null {
  if (denominator <= 0n) return null;
  if (numerator >= denominator) return "0.0000";
  if (numerator <= 0n) return "100.0000";
  return ratio(denominator - numerator, denominator, 4);
}

/**
 * The rules RHQ applies to a row. finishRow already arranges for them to hold; this is the tripwire
 * that stops a future change from shipping a snapshot RHQ would reject whole.
 */
function assertRowAcceptable(row: SnapshotRowV1, sales: Minor, refunds: Minor) {
  const problems: string[] = [];
  if (refunds > 0n) problems.push("royalty_on_refunds is positive");
  if (refunds < 0n && row.units_refunded <= 0) {
    problems.push("royalty_on_refunds is negative with no units refunded");
  }
  if (sales > 0n && row.units_sold <= 0) {
    problems.push("royalty_on_sales is positive with no units sold");
  }
  if (row.units_sold <= 0 && row.units_refunded <= 0) {
    problems.push("no units sold or refunded");
  }
  if (problems.length > 0) {
    throw new Error(
      `Snapshot row ${JSON.stringify(row.identifiers)} ${row.currency} breaks RHQ's rules: ${problems.join("; ")}`,
    );
  }
}
