import type { Minor } from "../money";
import {
  addMonths,
  parsePeriod,
  periodOfInstant,
  refundCutoffFor,
  toEpochMillis,
  type Period,
  type Schedule,
} from "../period";
import type { CoreOrder, CoreRefund, Currency } from "../types";
import { saleEligibility, type SaleExclusionReason } from "./orderFilter";

/**
 * A refund whose order is not in the ledger (typically placed before the
 * connection's start date and outside the fetchable window). Only
 * the order id and sale currency are known, not the order's tax basis or lines.
 */
export interface OrphanRefund {
  orderId: string;
  refund: CoreRefund;
  currency: Currency;
}

export interface SelectForPeriodInput {
  period: Period;
  /** Every ledger order that could matter: sold in P, or refunded in or after P. */
  orders: CoreOrder[];
  orphanRefunds: OrphanRefund[];
  /** Timezone is passed separately; the rest of the push schedule. */
  schedule: Omit<Schedule, "timezone">;
  /** Store IANA zone. */
  timezone: string;
  /** Cut-offs RHQ recorded for already-pushed periods (handshake). */
  recordedCutoffs: ReadonlyMap<Period, string>;
  /** Periods whose snapshot RHQ has imported (snapshot log); never rewritten with new refunds. */
  committedPeriods: ReadonlySet<Period>;
  /**
   * Per pushed period, the ids of every refund its accepted live snapshot
   * carried (snapshot log pushedRefundIds), money-only refunds applied to a
   * pushed sale included. Per period, not one set: a refund stays in the
   * period that carried it, which a bare "was pushed somewhere" cannot say.
   */
  refundsAlreadyPushed: ReadonlyMap<Period, ReadonlySet<string>>;
  /**
   * Per pushed period, the ignored money-only refunds its accepted snapshot
   * reported (snapshot log reportedMoneyOnlyRefundIds). Per period so a
   * report stays in the month that made it, like a carried refund.
   */
  moneyOnlyRefundsAlreadyReported: ReadonlyMap<Period, ReadonlySet<string>>;
  /**
   * Per pushed period, the money-only refunds its accepted snapshot APPLIED
   * to its sales (snapshot log appliedMoneyOnlyRefundIds). Kept apart from
   * refundsAlreadyPushed (refund rows): a refund with lines and money-only
   * money can have its lines carried while its money-only part was ignored,
   * and "carried" must not turn into "applied" on the next re-push.
   */
  appliedMoneyOnlyRefundIds: ReadonlyMap<Period, ReadonlySet<string>>;
  /**
   * Per pushed period, the sale orders its accepted live snapshot contained
   * (snapshot log pushedOrderIds). A committed period with no entry is
   * unknown and is treated as having carried every sale it could have: a
   * sale is re-booked out of a committed period only when that period's
   * list is known and lacks it.
   */
  ordersAlreadyPushed: ReadonlyMap<Period, ReadonlySet<string>>;
}

export interface AttributedRefund {
  order: CoreOrder;
  refund: CoreRefund;
  /**
   * The order's effective sale period (its paid month, or the month a late
   * sale was re-booked into); the refund nets onto that sale's row when it
   * equals P, and that period's cut-off decides where the refund goes.
   */
  salePeriod: Period;
  /**
   * Captured after the period the cut-off rule gives it had been committed,
   * so re-booked forward into P (summary.late_refunds).
   */
  late: boolean;
}

export interface UnmatchedRefund {
  orderId: string;
  refundId: string;
  currency: Currency;
  /**
   * Σ line amounts + shipping amount, as a POSITIVE magnitude (the sign the
   * refund carries in the ledger), on the order's own tax basis. It is not
   * negated or tax-stripped here: without the order we do not know whether
   * that basis is tax-inclusive, so the tax is reported beside it rather than
   * guessed away, and the summary layer decides how to present both.
   */
  amount: Minor;
  /** Σ line tax + shipping tax, positive, as recorded on the refund. */
  tax: Minor;
}

/**
 * The part of a refund that is money outside lines and shipping
 * (CoreRefund.unallocatedAmount).
 */
export interface MoneyOnlyRefund {
  orderId: string;
  refundId: string;
  currency: Currency;
  /** Gross, on the order's tax basis, as recorded: positive = more refunded. */
  amount: Minor;
  createdAt: string;
}

export type MoneyOnlyIgnoredReason =
  /** Made after the sale period's cut-off. */
  | "after_cutoff"
  /** Captured after the sale period's accepted live push, which did not carry it. */
  | "sale_period_pushed"
  /** Its order is not in the ledger. */
  | "order_not_in_ledger"
  /** The sale has no line to lower (e.g. gift cards only); decided by buildSnapshot. */
  | "no_sale_lines";

export interface IgnoredMoneyOnlyRefund extends MoneyOnlyRefund {
  reason: MoneyOnlyIgnoredReason;
}

export interface ExcludedOrder {
  orderId: string;
  reason: Exclude<SaleExclusionReason, "outside_period">;
}

export interface PeriodSelection {
  /** Eligible orders whose effective sale period is P, in ledger order. */
  sales: CoreOrder[];
  /** Ids of the `sales` re-booked into P from a committed month (summary.late_sales). */
  lateSales: string[];
  /**
   * Refunds attributed to P, in ledger order (order, then refund). A refund
   * that is nothing but money-only money is never here: it is not a refund
   * row (see saleAdjustments / ignoredMoneyOnly).
   */
  refunds: AttributedRefund[];
  /**
   * Money-only refund money that lowers a sale of P (each order here is in
   * `sales`), in ledger order.
   */
  saleAdjustments: MoneyOnlyRefund[];
  /** Money-only refund money ignored for royalties and reported in P. */
  ignoredMoneyOnly: IgnoredMoneyOnlyRefund[];
  unmatchedRefunds: UnmatchedRefund[];
  /** Ineligible orders whose sale or refund would have landed in P; one entry per order. */
  excluded: ExcludedOrder[];
  /** P's cut-off for the payload: the recorded one if P was pushed, else scheduled. */
  refundCutoffAt: string;
}

/**
 * Which sales and refunds belong in period P's snapshot.
 *
 * The rule that keeps every refund in exactly one snapshot: a refund of an
 * order sold in S nets into S when `createdAt ≤ cutoff(S)`, otherwise into the
 * month of `createdAt` in the store's zone. It is evaluated from the refund's
 * point of view (where does it go?) rather than P's (what falls in my
 * window?), because the cut-off that matters is the *sale* month's, and a
 * 6-month cycle means that month's cut-off can be months after P ends.
 *
 * cutoff(S) is the recorded one when RHQ has it: re-pushing S, or pushing a
 * later month, must not move a refund between months just because the owner
 * changed the schedule after S went out.
 */
export function selectForPeriod(input: SelectForPeriodInput): PeriodSelection {
  const period = parsePeriod(input.period);
  const tz = input.timezone;
  const schedule: Schedule = { ...input.schedule, timezone: tz };
  const periodOf = (iso: string): Period => periodOfInstant(iso, tz);
  // Validates the schedule and zone up front, so a bad setting fails even
  // when the ledger is empty rather than only once an order turns up.
  const refundCutoffAt = refundCutoffFor(
    period,
    schedule,
    input.recordedCutoffs,
  );

  // Each sale period's cut-off is looked up once, not per refund: it parses
  // an ISO string and the ledger can hold thousands of refunds per month.
  const cutoffMs = new Map<Period, number>();
  const cutoffMillisFor = (s: Period): number => {
    let ms = cutoffMs.get(s);
    if (ms === undefined) {
      ms = toEpochMillis(refundCutoffFor(s, schedule, input.recordedCutoffs));
      cutoffMs.set(s, ms);
    }
    return ms;
  };
  const byCutoff = (salePeriod: Period, refund: CoreRefund): Period =>
    toEpochMillis(refund.createdAt) <= cutoffMillisFor(salePeriod)
      ? salePeriod
      : periodOf(refund.createdAt);

  // A refund the cut-off rule puts in a period RHQ has already imported, but
  // which that period's pushed snapshot did not carry, was captured late
  // (webhook missed, found by the daily reconcile). Re-pushing that period
  // would rewrite a month the publisher may already have run royalties on,
  // so it is booked into the earliest open period from its own date onward:
  // still once, never dropped, and reported. A refund the snapshot did carry
  // stays put, so re-pushing a committed period reproduces it exactly.
  //
  // A refund an accepted snapshot already carried stays in THAT snapshot's
  // period, whatever has been imported or undone in RHQ since: RHQ holds
  // it there, so placing it anywhere else counts it twice (or, re-pushing
  // the carrying month, drops it). It is still marked late if the cut-off
  // rule would put it elsewhere, so that month re-pushes byte-identical.
  const refundCarriedBy = new Map<string, Period>();
  for (const [p, refundIds] of [...input.refundsAlreadyPushed].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    for (const id of refundIds) {
      // The earliest wins if a bug ever recorded one twice: deterministic.
      if (!refundCarriedBy.has(id)) refundCarriedBy.set(id, p);
    }
  }
  const refundPeriod = (
    salePeriod: Period,
    refund: CoreRefund,
  ): { period: Period; late: boolean } => {
    const s = byCutoff(salePeriod, refund);
    const carried = refundCarriedBy.get(refund.id);
    if (carried !== undefined) return { period: carried, late: carried !== s };
    if (!input.committedPeriods.has(s)) return { period: s, late: false };
    let target = periodOf(refund.createdAt);
    // Terminates: each step moves past one committed period, and there are
    // finitely many.
    while (input.committedPeriods.has(target)) target = addMonths(target, 1);
    return { period: target, late: true };
  };

  // Money-only refund money (order adjustments) has no line, so it cannot be
  // a refund row: RHQ would need units to carry it. While
  // the sale's period has not gone out it is a lower sale price, so it
  // lowers the sale; once the sale has been sent (or the cut-off has
  // passed) it is ignored for royalties, never booked into a later month,
  // and only reported.
  //
  // "Not gone out" must give the same answer on every re-push, or re-pushing
  // a staged period would change it. So it
  // applies iff the sale period's accepted live push APPLIED it, or the
  // period has no accepted live push yet and it is on or before the
  // cut-off. "Arrived after the push" therefore means captured after it:
  // the push did not apply it, so no re-push ever does, and the staged
  // snapshot stays byte-identical. Only the applied set is consulted, never
  // refundsAlreadyPushed: a mixed refund's lines being carried says nothing
  // about its money-only part.
  const pushedSalePeriod = (p: Period): boolean =>
    input.recordedCutoffs.has(p) || input.appliedMoneyOnlyRefundIds.has(p);
  const appliesToSale = (salePeriod: Period, refund: CoreRefund): boolean =>
    toEpochMillis(refund.createdAt) <= cutoffMillisFor(salePeriod) &&
    (!pushedSalePeriod(salePeriod) ||
      (input.appliedMoneyOnlyRefundIds.get(salePeriod)?.has(refund.id) ??
        false));

  // Where an ignored one is reported: its own month, but never the sale's
  // period, so the sale's (possibly staged) snapshot is not changed by it.
  // A committed month is skipped unless a pushed snapshot already reported
  // it, exactly as late refunds are re-booked, so each is
  // reported once and a committed month is never rewritten.
  // One a pushed snapshot already reported stays reported THERE, whatever
  // has been imported or undone since, as a carried refund does.
  const reportedBy = new Map<string, Period>();
  for (const [p, refundIds] of [...input.moneyOnlyRefundsAlreadyReported].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    for (const id of refundIds) if (!reportedBy.has(id)) reportedBy.set(id, p);
  }
  const reportPeriod = (salePeriod: Period, refund: CoreRefund): Period => {
    const reported = reportedBy.get(refund.id);
    if (reported !== undefined) return reported;
    let target = periodOf(refund.createdAt);
    // Periods are "YYYY-MM", so string order is month order.
    if (target <= salePeriod) target = addMonths(salePeriod, 1);
    if (!input.committedPeriods.has(target)) return target;
    while (input.committedPeriods.has(target)) target = addMonths(target, 1);
    return target;
  };

  // A sale stored after its month was imported (a deferred-payment order
  // found paid by reconciliation) mirrors the late-refund rule: re-pushing
  // that month would rewrite royalties the publisher may already have run,
  // so the sale is booked into the earliest open month from its own onward.
  // The walk stops at the first month that did (or may have) carried it, so
  // once the month it was booked into is committed too, it stays there
  // rather than moving again. A committed month whose list is unknown is
  // taken to have carried it: missing a late sale is recoverable, sending a
  // whole month's sales twice is not.
  //
  // A sale an accepted snapshot already carried stays in that snapshot's
  // period, whatever has been committed or undone since (say July was
  // imported without L, L late into August, August pushed, then July's
  // import undone; July's re-push must not take L back, or RHQ counts it
  // twice). Only a sale carried nowhere is placed by the walk.
  const saleCarriedBy = new Map<string, Period>();
  for (const [p, orderIds] of [...input.ordersAlreadyPushed].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    for (const id of orderIds) {
      if (!saleCarriedBy.has(id)) saleCarriedBy.set(id, p);
    }
  }
  const effectiveSalePeriod = (order: CoreOrder, paid: Period): Period => {
    const carried = saleCarriedBy.get(order.id);
    // Never before the paid month: a sale cannot be carried earlier.
    if (carried !== undefined && carried >= paid) return carried;
    let target = paid;
    while (input.committedPeriods.has(target)) {
      const pushed = input.ordersAlreadyPushed.get(target);
      if (pushed === undefined || pushed.has(order.id)) return target;
      target = addMonths(target, 1);
    }
    return target;
  };

  const sales: CoreOrder[] = [];
  const lateSales: string[] = [];
  const refunds: AttributedRefund[] = [];
  const saleAdjustments: MoneyOnlyRefund[] = [];
  const ignoredMoneyOnly: IgnoredMoneyOnlyRefund[] = [];
  const excluded: ExcludedOrder[] = [];
  const ledgerIds = new Set<string>();

  for (const order of input.orders) {
    ledgerIds.add(order.id);
    const paidPeriod = periodOf(order.paidAt);
    // Eligibility is judged against the order's own paid month so the status
    // and test checks are the same ones the sales side applies; only the
    // "is it in P" question differs between a sale and its refunds.
    const eligibility = saleEligibility(order, paidPeriod, periodOf);
    // Only a real sale can be late: an ineligible order was never sent, so
    // it stays in its paid month for the exclusion count.
    const salePeriod = eligibility.eligible
      ? effectiveSalePeriod(order, paidPeriod)
      : paidPeriod;
    // Refunds follow the EFFECTIVE sale period for cut-off purposes: the
    // sale is in that month's snapshot, so a refund made before that
    // month's cut-off nets with it there, exactly as for an on-time sale.
    const inP = order.refunds
      .filter((refund) => !isMoneyOnly(refund))
      .map((refund) => ({ refund, ...refundPeriod(salePeriod, refund) }))
      .filter((r) => r.period === period);

    if (!eligibility.eligible) {
      // A test or never-paid order had no sale in any snapshot, so netting its
      // refund anywhere would subtract royalties that were never added. The
      // order is still counted once for P's summary if P is where its sale or
      // a refund would have landed, so the owner can see why it is missing.
      if (
        eligibility.reason !== "outside_period" &&
        (salePeriod === period || inP.length > 0)
      ) {
        excluded.push({ orderId: order.id, reason: eligibility.reason });
      }
      continue;
    }

    if (salePeriod === period) {
      sales.push(order);
      if (salePeriod !== paidPeriod) lateSales.push(order.id);
    }
    for (const { refund, late } of inP) {
      refunds.push({ order, refund, salePeriod, late });
    }
    for (const refund of order.refunds) {
      const amount = refund.unallocatedAmount ?? 0n;
      if (amount === 0n) continue;
      const money: MoneyOnlyRefund = {
        orderId: order.id,
        refundId: refund.id,
        currency: order.currency,
        amount,
        createdAt: refund.createdAt,
      };
      if (appliesToSale(salePeriod, refund)) {
        if (salePeriod === period) saleAdjustments.push(money);
      } else if (reportPeriod(salePeriod, refund) === period) {
        ignoredMoneyOnly.push({
          ...money,
          reason:
            toEpochMillis(refund.createdAt) > cutoffMillisFor(salePeriod)
              ? "after_cutoff"
              : "sale_period_pushed",
        });
      }
    }
  }

  const unmatchedRefunds: UnmatchedRefund[] = [];
  for (const o of input.orphanRefunds) {
    if (ledgerIds.has(o.orderId)) {
      // Its refunds are already on the ledger order, so reporting it again as
      // unmatched would count the same money twice. The edge classified it
      // wrongly; fail loudly rather than pick one.
      throw new Error(
        `Orphan refund ${o.refund.id} names order ${o.orderId}, which is in the ledger`,
      );
    }
    // No sale month is known, so there is no cut-off to apply: the refund can
    // only be placed by its own date. It is reported, never dropped.
    if (periodOf(o.refund.createdAt) !== period) continue;
    const unallocated = o.refund.unallocatedAmount ?? 0n;
    if (unallocated !== 0n) {
      // No sale is known to lower, so it can only be ignored and reported.
      ignoredMoneyOnly.push({
        orderId: o.orderId,
        refundId: o.refund.id,
        currency: o.currency,
        amount: unallocated,
        createdAt: o.refund.createdAt,
        reason: "order_not_in_ledger",
      });
    }
    if (isMoneyOnly(o.refund)) continue;
    let amount = o.refund.shipping.amount;
    let tax = o.refund.shipping.tax;
    for (const l of o.refund.lines) {
      amount += l.amount;
      tax += l.tax;
    }
    unmatchedRefunds.push({
      orderId: o.orderId,
      refundId: o.refund.id,
      currency: o.currency,
      amount,
      tax,
    });
  }

  return {
    sales,
    lateSales,
    refunds,
    saleAdjustments,
    ignoredMoneyOnly,
    unmatchedRefunds,
    excluded,
    refundCutoffAt,
  };
}

/**
 * A refund carrying nothing but money-only money: no refunded quantity, no
 * line or shipping money. It is not a refund row at all (it would be a row
 * RHQ refuses: money with no units), only a sale adjustment or a report.
 */
export function isMoneyOnly(refund: CoreRefund): boolean {
  if ((refund.unallocatedAmount ?? 0n) === 0n) return false;
  if (refund.shipping.amount !== 0n || refund.shipping.tax !== 0n) return false;
  return refund.lines.every(
    (l) => l.quantity === 0 && l.amount === 0n && l.tax === 0n,
  );
}
