import {
  addMinutesInZone,
  addMonths,
  comparePeriods,
  periodOfInstant,
  periodRange,
  toEpochMillis,
  type Period,
} from "./period";
import { hasEnded } from "./schedule";

// Manual push mode: nothing goes to RHQ until a person
// pushes a month, one month per action.

export interface ManualPushOptions {
  timezone: string;
  backfillStart: Period;
  /** The first extracted month; a month before it would go out empty. */
  firstLedgerPeriod?: Period;
  /** Months with a complete extraction. */
  extracted: ReadonlySet<Period>;
  /** Months RHQ has accepted from a live push (staged or imported). */
  accepted: ReadonlySet<Period>;
  /** Months RHQ has imported: closed, and refused with period_committed. */
  imported: ReadonlySet<Period>;
}

/**
 * The months a person may push now, oldest first.
 *
 * Oldest first is the rule: a month cannot go while an earlier one
 * is unaccepted, because the refund-month rule for its refunds needs the
 * earlier month's cut-off, which only exists once that month is pushed. So
 * this is every accepted month that is not imported (a re-push), plus the
 * first month not yet accepted, if it has ended in both the store's zone and
 * UTC (RHQ's rule) and been extracted. A rejected or failed month is not
 * accepted, so it still blocks the ones after it.
 */
export function manuallyPushable(
  now: string,
  opts: ManualPushOptions,
): Period[] {
  let start = opts.backfillStart;
  if (
    opts.firstLedgerPeriod !== undefined &&
    comparePeriods(opts.firstLedgerPeriod, start) > 0
  ) {
    start = opts.firstLedgerPeriod;
  }
  const lastCandidate = addMonths(periodOfInstant(now, opts.timezone), -1);
  const pushable: Period[] = [];
  for (const p of periodRange(start, lastCandidate)) {
    if (opts.accepted.has(p)) {
      if (!opts.imported.has(p)) pushable.push(p);
      continue;
    }
    if (hasEnded(p, opts.timezone, now) && opts.extracted.has(p)) {
      pushable.push(p);
    }
    break;
  }
  return pushable;
}

/**
 * A manually pushed month's refund cut-off: the moment it is pushed,
 * in the store's zone, to the second. RHQ requires seconds and an offset,
 * and a re-push reuses the cut-off recorded at the first push.
 */
export function manualCutoffAt(now: string, timezone: string): string {
  const ms = toEpochMillis(now);
  const second = new Date(ms - (((ms % 1000) + 1000) % 1000)).toISOString();
  return addMinutesInZone(second, 0, timezone);
}
