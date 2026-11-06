import { pushOffsetMinutes } from "./jitter";
import {
  addMinutesInZone,
  addMonths,
  assertTimeZone,
  comparePeriods,
  localMidnight,
  monthIndex,
  periodEnd,
  periodFromIndex,
  periodOfInstant,
  periodParts,
  periodRange,
  toEpochMillis,
  type Period,
} from "./period";

/** The push schedule; a subset of CoreSettings. */
export interface Schedule {
  frequencyMonths: number; // 1..12
  anchorMonth: number; // 1..12, a month that starts a cycle
  pushDay: number; // 1..28 of the month after the cycle's last month
  timezone: string; // store IANA zone
}

export interface Cycle {
  first: Period;
  last: Period;
  months: Period[];
}

/** Snapshot status as RHQ's handshake reports it. */
export type PeriodStatus = "staged" | "rejected" | "imported";

function inRange(n: number, lo: number, hi: number): boolean {
  return Number.isInteger(n) && n >= lo && n <= hi;
}

export function validateSchedule(s: Schedule): void {
  if (!inRange(s.frequencyMonths, 1, 12)) {
    throw new Error(`frequencyMonths ${s.frequencyMonths} is not 1–12`);
  }
  if (!inRange(s.anchorMonth, 1, 12)) {
    throw new Error(`anchorMonth ${s.anchorMonth} is not 1–12`);
  }
  // Capped at 28 so the push day exists in every month, February included;
  // a "31st" would have to be clamped and the cut-off would wander.
  if (!inRange(s.pushDay, 1, 28)) {
    throw new Error(`pushDay ${s.pushDay} is not 1–28`);
  }
  assertTimeZone(s.timezone);
}

/**
 * The cycle containing `p`.
 *
 * Cycles are one unbroken sequence of `frequencyMonths`-long blocks, phased so
 * that a block starts wherever monthIndex ≡ anchor (mod frequency), with
 * monthIndex counted from January of year 0. For a frequency that divides 12
 * this just means "the anchor month starts a cycle every year". For one that
 * doesn't (5, 7, ...), a year-by-year restart at the anchor would leave
 * a short stub cycle each year, so the sequence instead runs on
 * across years and the anchor month starts a cycle only in some years (for 5:
 * years divisible by 5). The fixed epoch makes that deterministic: the same
 * settings give the same cycles on every server, forever.
 */
export function cycleOf(
  p: Period,
  s: Pick<Schedule, "frequencyMonths" | "anchorMonth">,
): Cycle {
  if (!inRange(s.frequencyMonths, 1, 12) || !inRange(s.anchorMonth, 1, 12)) {
    throw new Error("cycleOf: frequencyMonths and anchorMonth must be 1–12");
  }
  const f = s.frequencyMonths;
  const i = monthIndex(p);
  // Non-negative modulo: JS % keeps the dividend's sign.
  const phase = (((i - (s.anchorMonth - 1)) % f) + f) % f;
  const firstIndex = i - phase;
  const first = periodFromIndex(firstIndex);
  const last = periodFromIndex(firstIndex + f - 1);
  return { first, last, months: periodRange(first, last) };
}

/**
 * The scheduled refund cut-off for `p`: 00:00 local (see localMidnight for the
 * DST rule) on `pushDay` of the month after its cycle's last month. Every
 * month in a cycle shares it. Returned as ISO with the store's
 * offset, e.g. "2026-09-15T00:00:00+12:00".
 */
export function scheduledCutoffFor(p: Period, s: Schedule): string {
  validateSchedule(s);
  const pushMonth = periodParts(addMonths(cycleOf(p, s).last, 1));
  return localMidnight(pushMonth.year, pushMonth.month, s.pushDay, s.timezone);
}

/**
 * The cut-off to attribute refunds with.
 *
 * A cut-off RHQ recorded for an already-pushed period always wins over the
 * current schedule: re-pushing with a recomputed cut-off would silently move
 * refunds between months if the owner has since changed the schedule, and
 * because a re-push must reproduce the period exactly. The recorded
 * string is returned untouched so it compares equal to RHQ's copy.
 */
export function refundCutoffFor(
  p: Period,
  s: Schedule,
  recorded?: ReadonlyMap<Period, string>,
): string {
  return recorded?.get(p) ?? scheduledCutoffFor(p, s);
}

/**
 * When this store pushes `p`'s cycle: the scheduled cut-off plus the store's
 * jitter (01:00–05:59 later). Deliberately based on the *scheduled* cut-off,
 * not a recorded one: this decides when to push next, which follows the
 * current settings.
 */
export function pushAtFor(p: Period, s: Schedule, storeKey: string): string {
  return addMinutesInZone(
    scheduledCutoffFor(p, s),
    pushOffsetMinutes(storeKey),
    s.timezone,
  );
}

/**
 * Whether `p` has ended in BOTH the store's zone and UTC at `now`.
 *
 * RHQ refuses a period that has not ended in either (422 `period_not_ended`).
 * A store ahead of UTC finishes its month hours before UTC does, so checking
 * only the store zone would push too early; one behind UTC is the reverse.
 */
export function hasEnded(p: Period, tz: string, now: string): boolean {
  const t = toEpochMillis(now);
  return (
    t >= toEpochMillis(periodEnd(p, tz)) &&
    t >= toEpochMillis(periodEnd(p, "UTC"))
  );
}

export interface PeriodsDueOptions {
  /** Stable per-store key the push minute is derived from (see jitter). */
  storeKey: string;
  /** The publisher's backfill start month. */
  backfillStart: Period;
  /** Earliest month the ledger holds; months before it have no data to send. */
  firstLedgerPeriod?: Period;
  /** Per-period status from RHQ's handshake. */
  statuses: ReadonlyMap<Period, PeriodStatus>;
  /**
   * Accepted but deliberately unused here: whether a staged or rejected
   * period is actually re-sent depends on the hash of the payload *built now*,
   * which needs the ledger. That comparison belongs to the push step.
   */
  lastPushedHash?: ReadonlyMap<Period, string>;
}

/**
 * Periods to push at `now`, oldest first.
 *
 * A period is due when its cycle's jittered push instant has passed, it has
 * ended in both the store zone and UTC, it is on or after the start month, and
 * RHQ has not imported it. So backfill months whose cycle push date is long
 * past are due immediately, while months in the still-open cycle wait for its
 * push date even though they have ended.
 *
 * The start is the later of the backfill start and the first ledger period:
 * a month before the ledger begins would go out as an empty snapshot, telling
 * RHQ that month had no sales when we simply never extracted it.
 *
 * Only `imported` is excluded (RHQ answers 409 `period_committed` and must not
 * be retried automatically). `staged` and `rejected` periods are still
 * returned: a rejected one may succeed after the RHQ user resolves the
 * clash, and a staged one may have gained late refunds. The push step skips
 * those whose payload hash is unchanged.
 */
export function periodsDue(
  now: string,
  s: Schedule,
  opts: PeriodsDueOptions,
): Period[] {
  validateSchedule(s);
  const nowMs = toEpochMillis(now);
  let start = opts.backfillStart;
  if (
    opts.firstLedgerPeriod !== undefined &&
    comparePeriods(opts.firstLedgerPeriod, start) > 0
  ) {
    start = opts.firstLedgerPeriod;
  }
  // The month containing `now` in the store zone cannot have ended there, so
  // the one before it bounds the search; hasEnded then applies the UTC half.
  const lastCandidate = addMonths(periodOfInstant(now, s.timezone), -1);

  const due: Period[] = [];
  for (const p of periodRange(start, lastCandidate)) {
    if (opts.statuses.get(p) === "imported") continue;
    if (!hasEnded(p, s.timezone, now)) continue;
    if (toEpochMillis(pushAtFor(p, s, opts.storeKey)) > nowMs) continue;
    due.push(p);
  }
  return due;
}
