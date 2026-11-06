import type { CoreOrder } from "../types";

/**
 * A period key as produced by core/period ("YYYY-MM"). Declared locally,
 * and the period lookup taken as a parameter, so the filter does not depend on
 * how the period module computes months in a zone: the caller passes
 * `periodOfInstant(settings.timezone)`.
 */
export type PeriodKey = string;
export type PeriodOfInstant = (iso: string) => PeriodKey;

export type SaleExclusionReason = "status" | "test" | "outside_period";

export type SaleEligibility =
  { eligible: true } | { eligible: false; reason: SaleExclusionReason };

// Refunded and partially refunded orders were still paid, and their sale
// belongs to the month they were paid in; the refund is booked separately by
// the cut-off rule. Anything else (pending, authorised, voided) never
// became revenue.
const SOLD_STATUSES: ReadonlySet<CoreOrder["financialStatus"]> = new Set([
  "paid",
  "partially_refunded",
  "refunded",
]);

/**
 * Whether an order's sale counts in `period`,
 * with the reason when it does not so the summary can count exclusions.
 *
 * Membership is decided by `periodOf(paidAt)` in the store's zone, not by
 * slicing the ISO string: paidAt carries whatever offset the platform wrote
 * (Medusa writes UTC), which is not the store's offset.
 */
export function saleEligibility(
  order: Pick<CoreOrder, "financialStatus" | "test" | "paidAt">,
  period: PeriodKey,
  periodOf: PeriodOfInstant,
): SaleEligibility {
  if (!SOLD_STATUSES.has(order.financialStatus)) {
    return { eligible: false, reason: "status" };
  }
  if (order.test) {
    return { eligible: false, reason: "test" };
  }
  if (periodOf(order.paidAt) !== period) {
    return { eligible: false, reason: "outside_period" };
  }
  return { eligible: true };
}

export function isSaleEligible(
  order: Pick<CoreOrder, "financialStatus" | "test" | "paidAt">,
  period: PeriodKey,
  periodOf: PeriodOfInstant,
): boolean {
  return saleEligibility(order, period, periodOf).eligible;
}
