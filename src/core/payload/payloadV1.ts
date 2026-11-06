import {
  captureSaleContext,
  resolveBundles,
  saleViewOf,
  type EffectiveRefundLine,
  type ResolvedOrder,
} from "../bundles";
import { formatDecimal, formatFixed, parsePercent } from "../money";
import { isEmptied, netRefundsIntoSale } from "../rows/netting";
import type { Period } from "../period";
import {
  addTo,
  aggregateRows,
  type MoneyTotals,
  type RefundSource,
  type SaleSource,
} from "../rows/aggregate";
import {
  selectForPeriod,
  type IgnoredMoneyOnlyRefund,
  type MoneyOnlyIgnoredReason,
  type OrphanRefund,
  type PeriodSelection,
} from "../rows/attribution";
import { applySaleAdjustment } from "../rows/moneyOnly";
import { inferUnlinedRefunds, type UnlinedRefundNote } from "../rows/unlined";
import { periodOfInstant } from "../period";
import { validateSettings } from "../settings/validate";
import type {
  CoreOrder,
  CoreSettings,
  ProductConfig,
  SaleContext,
} from "../types";
import { buildSummary } from "./summary";
import type {
  PayloadV1,
  RowCountError,
  SnapshotSettingsV1,
  SnapshotWarning,
} from "./types";

/**
 * The row cap for an install whose handshake has no `api.limits`. Any other
 * install reports its own. The edge passes one or the other
 * as maxRows; the core never picks a default.
 */
export const MAX_SNAPSHOT_ROWS = 3100;

const CLIENT_VERSION_MAX = 50;

// The forms RHQ accepts: seconds required, a 3- or 6-digit fraction, and an
// explicit offset. A local time without an offset would be read in RHQ's
// zone, not the store's.
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface BuildSnapshotInput {
  period: Period;
  /** Every ledger order that could matter: sold in the period, or refunded in or after it. */
  orders: readonly CoreOrder[];
  orphanRefunds: readonly OrphanRefund[];
  /**
   * Refunds dated in the period on orders the edge never handed over because
   * they are no sale (never fully paid). Only counted: there is no sale to lower.
   */
  refundsOnUnpaidOrders?: number;
  /** Keyed by variant id. */
  products: ReadonlyMap<string, ProductConfig>;
  settings: CoreSettings;
  /** Cut-offs RHQ recorded for already-pushed periods (handshake). */
  recordedCutoffs: ReadonlyMap<Period, string>;
  /** Periods RHQ has imported (snapshot log): late-captured refunds are booked forward, not into these. */
  committedPeriods: ReadonlySet<Period>;
  /**
   * Per pushed period, the ids of every refund its accepted live snapshot
   * carried (snapshot log): each accepted live push's `pushedRefundIds`.
   */
  refundsAlreadyPushed: ReadonlyMap<Period, ReadonlySet<string>>;
  /**
   * Per pushed period, the ignored money-only refunds its accepted live
   * snapshot reported (snapshot log reportedMoneyOnlyRefundIds).
   */
  moneyOnlyRefundsAlreadyReported: ReadonlyMap<Period, ReadonlySet<string>>;
  /**
   * Per pushed period, the money-only refunds its accepted live snapshot
   * applied to its sales (snapshot log appliedMoneyOnlyRefundIds).
   */
  appliedMoneyOnlyRefundIds: ReadonlyMap<Period, ReadonlySet<string>>;
  /**
   * Per pushed period, the sale orders its accepted live snapshot contained
   * (snapshot log pushedOrderIds). A committed period with no entry is
   * unknown: its sales are never re-booked as late.
   */
  ordersAlreadyPushed: ReadonlyMap<Period, ReadonlySet<string>>;
  /** ISO instant with offset; passed in because the core may not read a clock. */
  generatedAt: string;
  clientVersion: string;
  /**
   * The install's row cap: handshake api.limits.max_rows, or
   * MAX_SNAPSHOT_ROWS for an install whose handshake lacks api.limits.
   * Required so a missing cap is a type error, not a silent fallback.
   */
  maxRows: number;
  /**
   * How refunds with no lines (money only) are read.
   *
   * - "spread" (the default): the
   *   money lowers the sale while its period has not gone out, and is
   *   otherwise ignored and reported; units never come back.
   * - "infer": refunds
   *   reaching the order total, or a cancellation, are a full return; an
   *   amount that is exactly one line's remainder, a whole number of its
   *   units, or the shipping is a refund of that, units included; anything
   *   else is spread as above.
   *
   * The Medusa edge always passes "infer": every Medusa refund is money
   * only, with no link to a return.
   */
  unlinedRefunds?: UnlinedRefundMode;
}

export type UnlinedRefundMode = "spread" | "infer";

export interface BuildSnapshotResult {
  payload: PayloadV1;
  warnings: SnapshotWarning[];
  /**
   * Set when the payload has more rows than the API accepts. The payload is
   * still complete: truncating would silently drop sales, so the push must
   * refuse and surface this instead.
   */
  rowCountError?: RowCountError;
  /**
   * Per sale order in this period (by order id): the context its sale was
   * built with. Orders only refunded here are absent: their context belongs
   * to their own sale period. The ledger records these when, and only when,
   * this payload is accepted as a live push (recordSaleContexts).
   */
  capturedSaleContexts: ReadonlyMap<string, SaleContext>;
  /**
   * Orders sold outside this period whose refunds this payload carries,
   * sorted. Each refund mirrored its sale's recorded context, so an accepted
   * live push of this payload freezes those contexts (freezeSaleContexts,
   * reason refund_reported): re-pushing the sale's period with a different
   * context would no longer match the refund RHQ holds.
   */
  refundedOrdersSoldElsewhere: string[];
  /**
   * Every refund this payload carried as a refund row, sorted. The push
   * step stores it as the snapshot log's pushedRefundIds on an accepted live
   * push, so a re-push keeps each where it is (late-refund rule).
   */
  pushedRefundIds: string[];
  /**
   * Money-only refunds applied to this payload's sales, sorted. Stored as
   * the snapshot log's appliedMoneyOnlyRefundIds, apart from
   * pushedRefundIds, so a re-push applies exactly these again.
   */
  appliedMoneyOnlyRefundIds: string[];
  /**
   * The sale orders this payload included, sorted (late sales re-booked
   * here included). The push step stores it as the snapshot log's
   * pushedOrderIds on an accepted live push, so a sale stored after its
   * month was committed can be told apart from one that month carried.
   */
  pushedOrderIds: string[];
  /**
   * Money-only refunds ignored for royalties and reported in this payload,
   * sorted. The push step stores it on an accepted live push, so each is
   * reported exactly once.
   */
  reportedMoneyOnlyRefundIds: string[];
  /**
   * The same ignored refunds in detail, for the Status page.
   * The push step stores them on the push attempt, and the Status and
   * attempt pages show them.
   */
  ignoredMoneyOnlyRefunds: IgnoredMoneyOnlyRefundReport[];
}

/** One money-only refund ignored for royalties, as the app reports it. */
export interface IgnoredMoneyOnlyRefundReport {
  orderId: string;
  refundId: string;
  currency: string;
  /** Gross decimal, as recorded: positive = money went back to the customer. */
  amount: string;
  createdAt: string;
  reason: MoneyOnlyIgnoredReason;
}

/**
 * Builds one period's snapshot.
 *
 * selectForPeriod decides which sales and refunds belong to the period (cut-
 * off rule), resolveBundles turns each order into effective lines (bundles
 * split, nets computed), and aggregateRows merges them into rows. Pure and
 * deterministic: the same ledger, settings and generatedAt always give the
 * same payload, whatever order the ledger listed orders in, so the payload
 * hash only changes when the data does.
 */
export function buildSnapshot(input: BuildSnapshotInput): BuildSnapshotResult {
  const { settings } = input;
  // A snapshot built on bad settings would be wrong in ways RHQ cannot see
  // (e.g. both commission and fees deducted without the user's say-so).
  const settingsErrors = validateSettings(settings);
  if (settingsErrors.length > 0) {
    throw new Error(
      `Invalid settings: ${settingsErrors.map((e) => e.code).join(", ")}`,
    );
  }
  if (!ISO_WITH_OFFSET.test(input.generatedAt)) {
    throw new Error(
      `generatedAt must be ISO 8601 with an offset, got ${JSON.stringify(input.generatedAt)}`,
    );
  }
  if (
    input.clientVersion.length === 0 ||
    input.clientVersion.length > CLIENT_VERSION_MAX
  ) {
    throw new Error(`clientVersion must be 1–${CLIENT_VERSION_MAX} characters`);
  }

  // Read refunds with no lines first, so everything after sees ordinary
  // refunds that name lines (rows/unlined.ts). Per order, over its whole
  // refund history: each refund's reading depends only on refunds dated
  // before it, so a pushed month keeps its content when later ones arrive.
  const infer = input.unlinedRefunds === "infer";
  const unlinedNotes: UnlinedRefundNote[] = [];
  const ledger: CoreOrder[] = infer
    ? input.orders.map((o) => {
        const r = inferUnlinedRefunds(o);
        unlinedNotes.push(...r.notes);
        return r.order;
      })
    : [...input.orders];

  const selection = selectForPeriod({
    period: input.period,
    orders: ledger,
    orphanRefunds: [...input.orphanRefunds],
    schedule: {
      frequencyMonths: settings.frequencyMonths,
      anchorMonth: settings.anchorMonth,
      pushDay: settings.pushDay,
    },
    timezone: settings.timezone,
    recordedCutoffs: input.recordedCutoffs,
    committedPeriods: input.committedPeriods,
    refundsAlreadyPushed: input.refundsAlreadyPushed,
    moneyOnlyRefundsAlreadyReported: input.moneyOnlyRefundsAlreadyReported,
    appliedMoneyOnlyRefundIds: input.appliedMoneyOnlyRefundIds,
    ordersAlreadyPushed: input.ordersAlreadyPushed,
  });

  // An order sold in this period is built from current config unless its
  // context is frozen (saleViewOf: a period can be pushed again after the
  // publisher fixes a flag); an order only refunded here mirrors its sale's
  // recorded context. Its refunds in this period go with its sale either
  // way, so the same view resolves both.
  const soldHere = new Set(selection.sales.map((o) => o.id));
  const viewOf = (order: CoreOrder): CoreOrder =>
    soldHere.has(order.id) ? saleViewOf(order) : order;

  // An order can contribute both a sale and refunds (or several refunds), and
  // resolution is the costly step, so each order is resolved once.
  const resolved = new Map<string, ResolvedOrder>();
  const resolve = (order: CoreOrder): ResolvedOrder => {
    let r = resolved.get(order.id);
    if (r === undefined) {
      r = resolveBundles(viewOf(order), input.products, settings);
      resolved.set(order.id, r);
    }
    return r;
  };
  const capturedSaleContexts = new Map<string, SaleContext>();

  const warnings: SnapshotWarning[] = [];
  const feeFallbackOrders = new Set<string>();
  const flatFeeMissingOrders = new Set<string>();
  // Sale and refund sides are kept apart: summed together, a sale's
  // unplaced shipping and a refund's would cancel and hide both.
  const unallocatedShipping = {
    sales: new Map() as MoneyTotals,
    refunds: new Map() as MoneyTotals,
  };
  let bundleSplitFallbacks = 0;
  let unknownBundleLines = 0;
  let manualComponentsMissing = 0;
  let netsClamped = 0;

  // Money-only refund money made before this period went out lowers its
  // sale; summed per order first so one allocation
  // spreads it, rather than one rounding per refund.
  const adjustmentOf = new Map<string, bigint>();
  for (const a of selection.saleAdjustments) {
    adjustmentOf.set(a.orderId, (adjustmentOf.get(a.orderId) ?? 0n) + a.amount);
  }
  const ignored: IgnoredMoneyOnlyRefund[] = [...selection.ignoredMoneyOnly];

  const lateSaleIds = new Set(selection.lateSales);
  const lateSales = { count: 0, byCurrency: new Map() as MoneyTotals };
  const sales: SaleSource[] = [];
  for (const order of selection.sales) {
    const r = resolve(order);
    capturedSaleContexts.set(
      order.id,
      captureSaleContext(viewOf(order), input.products, settings),
    );
    let saleLines = r.sale.lines;
    const adjustment = adjustmentOf.get(order.id) ?? 0n;
    if (adjustment !== 0n) {
      const adjusted = applySaleAdjustment(
        saleLines,
        adjustment,
        order,
        settings,
        !infer,
      );
      saleLines = adjusted.lines;
      if (adjusted.netsClamped > 0) {
        netsClamped += adjusted.netsClamped;
        warnings.push(netClampedWarning(order.id, null));
      }
      if (adjusted.unplaced !== 0n) {
        // No line to lower (a gift-card-only sale): nothing can carry it,
        // so it is reported like any other ignored money-only refund.
        for (const a of selection.saleAdjustments) {
          if (a.orderId === order.id) {
            ignored.push({ ...a, reason: "no_sale_lines" });
          }
        }
      }
    }
    sales.push({ order, lines: saleLines });
    if (lateSaleIds.has(order.id)) {
      // The net actually booked here: included lines only, as for late
      // refunds, since an unticked line is never sent wherever it lands.
      lateSales.count += 1;
      let net = 0n;
      for (const l of saleLines) if (l.included) net += l.net;
      addTo(lateSales.byCurrency, order.currency, net);
      warnings.push({
        code: "late_sale",
        orderId: order.id,
        subject: null,
        message:
          "Sale recorded after the month it was paid in was imported by RHQ; booked into this period instead.",
      });
    }
    if (r.sale.feeFallback) feeFallbackOrders.add(order.id);
    if (r.sale.flatFeeMissing) flatFeeMissingOrders.add(order.id);
    if (r.sale.netsClamped > 0) {
      netsClamped += r.sale.netsClamped;
      warnings.push(netClampedWarning(order.id, null));
    }
    if (r.sale.unallocatedShipping !== 0n) {
      addTo(
        unallocatedShipping.sales,
        order.currency,
        r.sale.unallocatedShipping,
      );
      warnings.push({
        code: "unallocated_shipping",
        orderId: order.id,
        subject: null,
        message:
          "Shipping on an order with no royalty lines to carry it was not included.",
      });
    }

    // Bundle notes are counted in the sale's period only: a later refund
    // month re-resolves the same order and would otherwise count it again.
    // A bundle whose guard failed and whose price_ratio fallback then fell
    // back to even raises two notes; the reviewer cares about one bundle.
    const seen = new Set<string>();
    for (const note of r.notes.bundleSplitFallbacks) {
      const ref =
        note.ref.kind === "group" ? note.ref.groupId : note.ref.lineId;
      if (seen.has(ref)) continue;
      seen.add(ref);
      bundleSplitFallbacks += 1;
      warnings.push({
        code: "bundle_split_fallback",
        orderId: order.id,
        subject: ref,
        message: `Bundle split by ${note.method} (${note.reason}).`,
      });
    }
    for (const u of r.notes.unknownBundleLines) {
      unknownBundleLines += 1;
      warnings.push({
        code: "unknown_bundle_line",
        orderId: order.id,
        subject: u.lineId,
        message: `"${u.title}" was sold at zero beside priced lines with no bundle information.`,
      });
    }
    for (const m of r.notes.manualComponentsMissing) {
      manualComponentsMissing += 1;
      warnings.push({
        code: "manual_component_missing",
        orderId: order.id,
        subject: m.variantId,
        message:
          "A manual bundle names a component with no product settings; its share was treated as unticked.",
      });
    }
  }

  const refunds: RefundSource[] = [];
  const netted = new Map<string, EffectiveRefundLine[]>();
  const lateRefunds = { count: 0, byCurrency: new Map() as MoneyTotals };
  for (const { order, refund, late } of selection.refunds) {
    const effective = resolve(order).refunds.find(
      (x) => x.refundId === refund.id,
    );
    // resolveBundles maps every refund of the order, so this cannot miss.
    if (effective === undefined) {
      throw new Error(
        `Refund ${refund.id} did not resolve on order ${order.id}`,
      );
    }
    // A refund attributed to the month its order sold in was made by that
    // month's cut-off: it lowers the sale instead. A late one
    // was re-booked from a committed month and stays a refund.
    if (!late && soldHere.has(order.id)) {
      netted.set(order.id, [
        ...(netted.get(order.id) ?? []),
        ...effective.lines,
      ]);
    } else {
      refunds.push({ order, refund: effective });
    }
    if (late) {
      // The net actually booked here: included lines only, since an unticked
      // line's refund is never sent wherever it lands.
      lateRefunds.count += 1;
      let net = 0n;
      for (const l of effective.lines) if (l.included) net += l.net;
      addTo(lateRefunds.byCurrency, order.currency, net);
      warnings.push({
        code: "late_refund",
        orderId: order.id,
        subject: refund.id,
        message:
          "Refund captured after the period it belongs to was imported by RHQ; booked into this period instead.",
      });
    }
    if (effective.feeFallback) feeFallbackOrders.add(order.id);
    if (effective.flatFeeMissing) flatFeeMissingOrders.add(order.id);
    if (effective.netsClamped > 0) {
      netsClamped += effective.netsClamped;
      warnings.push(netClampedWarning(order.id, refund.id));
    }
    if (effective.unallocatedShipping !== 0n) {
      addTo(
        unallocatedShipping.refunds,
        order.currency,
        effective.unallocatedShipping,
      );
      warnings.push({
        code: "unallocated_shipping",
        orderId: order.id,
        subject: refund.id,
        message:
          "Refunded shipping on an order with no royalty lines to carry it was not included.",
      });
    }
  }

  for (const id of [...feeFallbackOrders].sort()) {
    warnings.push({
      code: "fee_fallback",
      orderId: id,
      subject: null,
      message:
        "No card fee recorded for this order; the flat fee percentage was used.",
    });
  }
  for (const id of [...flatFeeMissingOrders].sort()) {
    warnings.push({
      code: "flat_fee_missing",
      orderId: id,
      subject: null,
      message:
        "A flat card fee was needed but none is set; no fee was deducted.",
    });
  }
  // Sorted so the warnings, report and summary do not depend on the order
  // the ledger listed refunds in.
  ignored.sort((a, b) =>
    a.refundId < b.refundId ? -1 : a.refundId > b.refundId ? 1 : 0,
  );
  const ignoredByCurrency = new Map() as MoneyTotals;
  for (const i of ignored) {
    addTo(ignoredByCurrency, i.currency, i.amount);
    warnings.push({
      code: "money_only_refund_ignored",
      orderId: i.orderId,
      subject: i.refundId,
      message:
        "Money refunded outside the order's lines after its sale was sent (or with no order to lower); not deducted from royalties.",
    });
  }

  for (const u of selection.unmatchedRefunds) {
    warnings.push({
      code: "unmatched_refund",
      orderId: u.orderId,
      subject: u.refundId,
      message:
        "Refund of an order that is not in the ledger; reported, not sent.",
    });
  }

  const unlinedCounts = countUnlinedNotes(
    unlinedNotes,
    selection,
    ignored,
    (iso) => periodOfInstant(iso, settings.timezone) === input.period,
  );
  warnings.push(...unlinedCounts.warnings);

  for (let i = 0; i < sales.length; i += 1) {
    const sale = sales[i]!;
    const lines = netted.get(sale.order.id);
    if (lines === undefined) continue;
    const result = netRefundsIntoSale(sale.lines, lines);
    sales[i] = {
      order: sale.order,
      lines: result.lines.filter((l) => !isEmptied(l)),
    };
    if (result.unmatched.length > 0) {
      refunds.push({
        order: sale.order,
        refund: {
          refundId: `${sale.order.id}:unmatched`,
          createdAt: sale.order.paidAt,
          lines: result.unmatched,
          feeFallback: false,
          flatFeeMissing: false,
          unallocatedShipping: 0n,
          netsClamped: 0,
        },
      });
    }
  }

  const aggregate = aggregateRows({
    sales,
    refunds,
    products: input.products,
    saleCountry: settings.saleCountry,
  });
  warnings.push(...aggregate.warnings);

  const payload: PayloadV1 = {
    schema_version: 1,
    period: input.period,
    store_timezone: settings.timezone,
    generated_at: input.generatedAt,
    client: { platform: "medusa", version: input.clientVersion },
    settings: settingsBlock(
      settings,
      selection.refundCutoffAt,
      feeGatewayNames(
        [...feeFallbackOrders].map(
          (id) => ledger.find((o) => o.id === id)?.gateway ?? null,
        ),
      ),
    ),
    rows: aggregate.rows,
    summary: buildSummary({
      ordersIncluded: selection.sales.length,
      ordersExcluded: selection.excluded.length,
      refundsIncluded: selection.refunds.length,
      aggregate,
      unmatchedRefunds: selection.unmatchedRefunds,
      bundleSplitFallbacks,
      unknownBundleLines,
      feeFallbackOrders: feeFallbackOrders.size,
      flatFeeMissingOrders: flatFeeMissingOrders.size,
      unallocatedShipping,
      manualComponentsMissing,
      netsClamped,
      lateRefunds,
      lateSales,
      refundsOnUnpaidOrders: input.refundsOnUnpaidOrders,
      ignoredMoneyOnly: {
        count: ignored.length,
        byCurrency: ignoredByCurrency,
      },
      ...(infer ? { unlinedRefunds: unlinedCounts.counts } : {}),
    }),
  };

  const result: BuildSnapshotResult = {
    payload,
    warnings,
    capturedSaleContexts,
    refundedOrdersSoldElsewhere: [
      ...new Set(
        selection.refunds
          .map(({ order }) => order.id)
          .filter((id) => !soldHere.has(id)),
      ),
    ].sort(),
    pushedOrderIds: selection.sales.map((o) => o.id).sort(),
    pushedRefundIds: [
      ...new Set(selection.refunds.map(({ refund }) => refund.id)),
    ].sort(),
    // An applied refund that found no line to lower is listed too: it was
    // decided against this sale, so a re-push must decide it the same way
    // (and report it here again) rather than re-report it next month.
    appliedMoneyOnlyRefundIds: [
      ...new Set(selection.saleAdjustments.map((a) => a.refundId)),
    ].sort(),
    reportedMoneyOnlyRefundIds: [
      ...new Set(ignored.map((i) => i.refundId)),
    ].sort(),
    ignoredMoneyOnlyRefunds: ignored.map((i) => ({
      orderId: i.orderId,
      refundId: i.refundId,
      currency: i.currency,
      amount: formatDecimal(i.amount, i.currency),
      createdAt: i.createdAt,
      reason: i.reason,
    })),
  };
  const maxRows = input.maxRows;
  if (payload.rows.length > maxRows) {
    result.rowCountError = {
      code: "too_many_rows",
      rows: payload.rows.length,
      max: maxRows,
    };
  }
  return result;
}

function netClampedWarning(
  orderId: string,
  refundId: string | null,
): SnapshotWarning {
  return {
    code: "net_clamped",
    orderId,
    subject: refundId,
    message:
      "Commission and card fee exceeded the line's value; the fee was reduced so the royalty is zero rather than reversed.",
  };
}

/** The settings block: what the snapshot was built with. */
// RHQ's limits on settings.fee_gateway_fallbacks: 50 names,
// 1 to 100 characters each, no control characters.
const MAX_GATEWAYS = 50;
const GATEWAY_MAX_CHARS = 100;

/**
 * The gateways behind fee fallbacks, as RHQ accepts them: once each, sorted,
 * an unrecorded one as "unknown". A name is the gateway's own text, so
 * anything RHQ would refuse is cleaned rather than risk the whole month.
 */
function feeGatewayNames(gateways: readonly (string | null)[]): string[] {
  const names = new Set<string>();
  for (const gateway of gateways) {
    // By code point, not a regex of control characters, which lint
    // rightly reads as a likely typo.
    const clean = Array.from(gateway ?? "")
      .filter((c) => {
        const cp = c.codePointAt(0)!;
        return cp > 0x1f && (cp < 0x7f || cp > 0x9f);
      })
      .slice(0, GATEWAY_MAX_CHARS)
      .join("")
      .trim();
    names.add(clean === "" ? "unknown" : clean);
  }
  return [...names].sort().slice(0, MAX_GATEWAYS);
}

function settingsBlock(
  settings: CoreSettings,
  refundCutoffAt: string,
  feeGatewayFallbacks: string[],
): SnapshotSettingsV1 {
  return {
    commission_percent:
      settings.commissionPercent === null
        ? null
        : canonicalPercent(settings.commissionPercent),
    card_fee_mode: settings.cardFeeMode,
    include_shipping: settings.includeShipping,
    bundle_split: settings.bundleSplit,
    frequency_months: settings.frequencyMonths,
    push_day: settings.pushDay,
    refund_cutoff_at: refundCutoffAt,
    push_mode: settings.pushMode,
    card_fee_flat_percent:
      settings.flatFeePercent === null
        ? null
        : canonicalPercent(settings.flatFeePercent),
    commission_excludes_fees_confirmed:
      settings.commissionExcludesFeesConfirmed,
    fee_gateway_fallbacks: feeGatewayFallbacks,
  };
}

/**
 * "12.50" → "12.5", "015" → "15". The stored setting may carry padding that
 * parsePercent tolerates but the API's Percent pattern does not (it allows at
 * most two integer digits), and one value should always print one way so the
 * payload hash does not change when a setting is merely re-saved.
 */
export function canonicalPercent(text: string): string {
  const fixed = formatFixed(parsePercent(text), 4);
  return fixed.replace(/\.?0+$/, "");
}

/**
 * The notes from reading unlined refunds that belong to this period: an
 * inferred refund where it was booked (as a refund row or netted into its
 * sale), an ambiguous one where its money was applied or reported, and a
 * refund voided by a full return in its own month (it is booked nowhere).
 */
function countUnlinedNotes(
  notes: readonly UnlinedRefundNote[],
  selection: PeriodSelection,
  ignored: readonly IgnoredMoneyOnlyRefund[],
  inPeriod: (iso: string) => boolean,
): {
  counts: { inferred: number; ambiguous: number; afterFullReturn: number };
  warnings: SnapshotWarning[];
} {
  const booked = new Set(selection.refunds.map(({ refund }) => refund.id));
  const spread = new Set([
    ...selection.saleAdjustments.map((a) => a.refundId),
    ...ignored.map((i) => i.refundId),
  ]);
  const counts = { inferred: 0, ambiguous: 0, afterFullReturn: 0 };
  const warnings: SnapshotWarning[] = [];
  for (const n of notes) {
    if (n.kind === "inferred_from_amount" && booked.has(n.refundId)) {
      counts.inferred += 1;
      warnings.push({
        code: "refund_inferred_from_amount",
        orderId: n.orderId,
        subject: n.refundId,
        message:
          "Refund with no lines read as the refund of the one line, shipping or gift card its amount matches.",
      });
    } else if (n.kind === "ambiguous_amount" && spread.has(n.refundId)) {
      counts.ambiguous += 1;
      warnings.push({
        code: "ambiguous_refund_amount",
        orderId: n.orderId,
        subject: n.refundId,
        message:
          "Refund with no lines whose amount matches more than one charge; spread over the order instead.",
      });
    } else if (n.kind === "after_full_return" && inPeriod(n.createdAt)) {
      counts.afterFullReturn += 1;
      warnings.push({
        code: "refund_after_full_return",
        orderId: n.orderId,
        subject: n.refundId,
        message:
          "Refund made after the order was cancelled or fully refunded; it adds nothing.",
      });
    }
  }
  return { counts, warnings };
}
