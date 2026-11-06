// Time-zone arithmetic on Intl alone.
//
// No zone library: the core may import nothing outside itself (the purity
// check). Libraries such as Luxon read their IANA zones from
// Intl.DateTimeFormat anyway, so going to Intl directly keeps the same zone
// database and the same answers. Only what the period code needs is here: validating a
// zone, parsing an ISO instant strictly, the wall clock and UTC offset of an
// instant in a zone, and ISO output in a zone.

// Digit strings are parsed by hand because the core bans calling Number or parseInt
// (aimed at money). Every caller has already regex-checked them.
export function digits(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n = n * 10 + (s.charCodeAt(i) - 48)
  return n
}

/** UTC epoch milliseconds of a proleptic Gregorian date and time. */
export function utcMillis(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  // Not Date.UTC(year, ...): it reads years 0–99 as 1900–1999.
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  d.setUTCHours(hour, minute, second, ms)
  return d.getTime()
}

// One formatter per zone: building them is the slow part of Intl.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatters.set(tz, f)
  }
  return f
}

/**
 * IANA names (and "UTC") only. Newer ICU builds accept an offset such as
 * "+03:00" as a time zone; a fixed offset has no DST and is never what a
 * store's settings actually hold, so accepting one would hide a misread
 * setting.
 */
export function isValidZone(tz: string): boolean {
  if (tz.trim() === "" || /^[+-]/.test(tz.trim())) return false
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall clock in `tz` at `ms` (to the second). */
export function wallClock(ms: number, tz: string): WallClock {
  const out: Record<string, string> = {}
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    out[part.type] = part.value
  }
  const year = digits(out.year ?? "")
  return {
    // A BC year would print as a positive year with era "B"; mirror it so the
    // offset maths stays right (no store sells books before AD 1).
    year: out.era === "B" || out.era === "BC" ? 1 - year : year,
    month: digits(out.month ?? ""),
    day: digits(out.day ?? ""),
    hour: digits(out.hour ?? ""),
    minute: digits(out.minute ?? ""),
    second: digits(out.second ?? ""),
  }
}

/** The zone's UTC offset at `ms`, in minutes east of UTC. */
export function offsetMinutes(ms: number, tz: string): number {
  const w = wallClock(ms, tz)
  const asUtc = utcMillis(w.year, w.month, w.day, w.hour, w.minute, w.second)
  const wholeSecond = ms - (((ms % 1000) + 1000) % 1000)
  return (asUtc - wholeSecond) / 60_000
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0")
}

/**
 * ISO 8601 for `ms` in `tz`, e.g. "2026-09-15T00:00:00+12:00".
 *
 * Milliseconds are left out when zero: cut-offs are recorded and compared as
 * text (RHQ echoes `refund_cutoff_at` back), so one canonical spelling avoids
 * a "changed" cut-off that differs only in ".000". The zone named "UTC" (or
 * "GMT") is written "Z", while a real zone that happens to
 * sit at offset zero (Europe/London in winter) is written "+00:00".
 */
export function toIsoInZone(ms: number, tz: string): string {
  const w = wallClock(ms, tz)
  const milli = ((ms % 1000) + 1000) % 1000
  const offset = offsetMinutes(ms, tz)
  const lowered = tz.toLowerCase()
  let suffix: string
  if (lowered === "utc" || lowered === "gmt") {
    suffix = "Z"
  } else {
    const sign = offset < 0 ? "-" : "+"
    const abs = offset < 0 ? -offset : offset
    const minutes = abs % 60
    suffix = `${sign}${pad((abs - minutes) / 60, 2)}:${pad(minutes, 2)}`
  }
  return (
    `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}` +
    `T${pad(w.hour, 2)}:${pad(w.minute, 2)}:${pad(w.second, 2)}` +
    (milli === 0 ? "" : `.${pad(milli, 3)}`) +
    suffix
  )
}

// Extended ISO 8601 date-time with a required offset. Narrower than Luxon's
// fromISO (no week or ordinal dates, no basic format): store and RHQ instants
// are always this shape, and anything else is better refused than guessed.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?)$/i

function daysInMonth(year: number, month: number): number {
  return new Date(utcMillis(year, month + 1, 0)).getUTCDate()
}

/** Epoch milliseconds of an ISO instant, or null when it is not valid. */
export function parseIsoInstant(instant: string): number | null {
  const m = ISO_INSTANT.exec(instant)
  if (!m) return null
  const year = digits(m[1]!)
  const month = digits(m[2]!)
  const day = digits(m[3]!)
  const hour = digits(m[4]!)
  const minute = digits(m[5]!)
  const second = m[6] === undefined ? 0 : digits(m[6])
  // Fractions past milliseconds are truncated, as Luxon did.
  const ms = m[7] === undefined ? 0 : digits(m[7].slice(0, 3).padEnd(3, "0"))
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null
  }
  let offset = 0
  if (m[8] === undefined) {
    const oh = digits(m[10]!)
    const om = m[11] === undefined ? 0 : digits(m[11])
    if (oh > 23 || om > 59) return null
    offset = (m[9] === "-" ? -1 : 1) * (oh * 60 + om)
  }
  return utcMillis(year, month, day, hour, minute, second, ms) - offset * 60_000
}
