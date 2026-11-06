import {
  digits,
  isValidZone,
  offsetMinutes,
  parseIsoInstant,
  toIsoInZone,
  utcMillis,
  wallClock,
} from "./zone";

/**
 * A royalty month, "YYYY-MM". It is a string rather than a Date because RHQ,
 * the ledger and the payload all key on this exact text, and a Date would
 * smuggle in a time of day and a zone that a month does not have.
 */
export type Period = string;

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

// An instant must name its own offset. Date (like Luxon) reads a bare
// "2026-08-31T23:30:00" in the host's zone, which would make the answer depend
// on where the server runs; the core must give the same result everywhere.
const OFFSET_RE = /(Z|[+-]\d{2}(:?\d{2})?)$/i;


export function isPeriod(s: string): boolean {
  return PERIOD_RE.test(s);
}

export function parsePeriod(s: string): Period {
  if (!isPeriod(s)) {
    throw new Error(`Invalid period ${JSON.stringify(s)}: expected YYYY-MM`);
  }
  return s;
}

function parts(p: Period): { year: number; month: number } {
  const m = PERIOD_RE.exec(p);
  if (!m) {
    throw new Error(`Invalid period ${JSON.stringify(p)}: expected YYYY-MM`);
  }
  return { year: digits(m[1]!), month: digits(m[2]!) };
}

/**
 * Months since January of year 0. A single integer turns month arithmetic
 * into addition and makes cycle phase (index mod frequency) well defined for
 * frequencies that do not divide 12.
 */
export function monthIndex(p: Period): number {
  const { year, month } = parts(p);
  return year * 12 + (month - 1);
}

export function periodFromIndex(index: number): Period {
  if (!Number.isInteger(index) || index < 12 || index > 9999 * 12 + 11) {
    throw new Error(`Month index ${index} is outside years 0001–9999`);
  }
  // Integer division by subtraction of the remainder: exact, no float floor.
  const month0 = index % 12;
  const year = (index - month0) / 12;
  return `${String(year).padStart(4, "0")}-${String(month0 + 1).padStart(2, "0")}`;
}

export function addMonths(p: Period, n: number): Period {
  if (!Number.isInteger(n)) {
    throw new Error(`addMonths: ${n} is not a whole number of months`);
  }
  return periodFromIndex(monthIndex(p) + n);
}

export function comparePeriods(a: Period, b: Period): -1 | 0 | 1 {
  const d = monthIndex(a) - monthIndex(b);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

/** Inclusive range, oldest first; empty when `from` is after `to`. */
export function periodRange(from: Period, to: Period): Period[] {
  const out: Period[] = [];
  const end = monthIndex(to);
  for (let i = monthIndex(from); i <= end; i++) out.push(periodFromIndex(i));
  return out;
}

export function assertTimeZone(tz: string): void {
  // Only IANA names (and "UTC"); see isValidZone for why fixed offsets fail.
  if (!isValidZone(tz)) {
    throw new Error(`Unknown IANA time zone ${JSON.stringify(tz)}`);
  }
}

function parseInstant(instant: string): number {
  if (!OFFSET_RE.test(instant)) {
    throw new Error(
      `Instant ${JSON.stringify(instant)} has no UTC offset; it would be read in the host's zone`,
    );
  }
  const ms = parseIsoInstant(instant);
  if (ms === null) {
    throw new Error(`Invalid ISO instant ${JSON.stringify(instant)}`);
  }
  return ms;
}

/** Milliseconds since the Unix epoch, for ordering instants. */
export function toEpochMillis(instant: string): number {
  return parseInstant(instant);
}

/** The month an instant falls in on the store's wall clock. */
export function periodOfInstant(instant: string, tz: string): Period {
  assertTimeZone(tz);
  const local = wallClock(parseInstant(instant), tz);
  return `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}`;
}

/**
 * The first instant of a local calendar day, as ISO with the zone's offset.
 *
 * DST rule: this is "00:00 local" where 00:00 exists once; otherwise it is the
 * first instant whose local date is that day.
 * - Midnight skipped (e.g. Chile springs forward at 24:00): the day begins at
 *   01:00, which is the same instant as the non-existent 00:00 read in the old
 *   offset, so nothing sold "before midnight" is lost or double counted.
 * - Midnight repeated (e.g. Cuba falls back at 01:00 to 00:00): the earlier
 *   00:00. The day has already begun then, and choosing the later one would
 *   leave an hour of the push day before its own cut-off.
 * Tests pin both cases, so a change in the zone maths cannot slip past.
 */
export function localMidnight(
  year: number,
  month: number,
  day: number,
  tz: string,
): string {
  assertTimeZone(tz);
  const nominal = utcMillis(year, month, day);
  if (Number.isNaN(nominal) || new Date(nominal).getUTCDate() !== day) {
    throw new Error(`Invalid local date ${year}-${month}-${day} in ${tz}`);
  }
  // Try the zone's offsets either side of the day and keep the earliest
  // instant that really is local midnight. Reading the offset at the day
  // itself would be ambiguous on an overlap, and a library that guesses from
  // the current clock answers differently before and after a transition.
  const offsets = [nominal - 86_400_000, nominal + 86_400_000].map((probe) =>
    offsetMinutes(probe, tz),
  );
  let earliest: number | null = null;
  for (const offset of offsets) {
    const candidate = nominal - offset * 60_000;
    const w = wallClock(candidate, tz);
    if (
      w.year === year &&
      w.month === month &&
      w.day === day &&
      w.hour === 0 &&
      w.minute === 0 &&
      (earliest === null || candidate < earliest)
    ) {
      earliest = candidate;
    }
  }
  // No candidate when midnight is skipped: read 00:00 in the offset before the
  // gap (the smaller one, as clocks go forward), which lands on the first
  // instant after it, e.g. 01:00 in the new offset.
  const shifted = nominal - Math.min(...offsets) * 60_000;
  return toIsoInZone(earliest ?? shifted, tz);
}

/** First instant of the period in `tz`. */
export function periodStart(p: Period, tz: string): string {
  const { year, month } = parts(p);
  return localMidnight(year, month, 1, tz);
}

/** Exclusive end of the period in `tz`: the first instant of the next month. */
export function periodEnd(p: Period, tz: string): string {
  return periodStart(addMonths(p, 1), tz);
}

/** Internal: year and month of a period for callers building local dates. */
export function periodParts(p: Period): { year: number; month: number } {
  return parts(p);
}

/** Internal: an instant plus whole minutes, kept in the given zone. */
export function addMinutesInZone(
  instant: string,
  minutes: number,
  tz: string,
): string {
  // Absolute minutes, not wall-clock minutes: on a DST day the local reading
  // shifts by the DST step, which is harmless for spreading load.
  return toIsoInZone(parseInstant(instant) + minutes * 60_000, tz);
}
