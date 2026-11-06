import type { Settings } from "./api"

/**
 * The month before this one in the store's zone: the default first month to
 * send, so enabling does not reach back into history nobody chose to report.
 * The store's zone, not the browser's: near midnight on the 1st they differ.
 */
export function lastMonth(timeZone: string | null, now: Date = new Date()): string {
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, year: "numeric", month: "2-digit" })
  } catch {
    // A zone the browser does not know: the server will refuse it anyway.
    format = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit" })
  }
  const parts = format.formatToParts(now)
  let year = Number(parts.find((p) => p.type === "year")!.value)
  let month = Number(parts.find((p) => p.type === "month")!.value) - 1
  if (month === 0) {
    month = 12
    year -= 1
  }
  return `${year}-${String(month).padStart(2, "0")}`
}

type FeeMode = Settings["card_fee_mode"]

/**
 * The card fee modes to offer. Actual fees are not offered for a new choice,
 * since the plugin cannot read them from Medusa, but a stored "actual" stays
 * on offer: a select without its value would show blank and save it away.
 */
export function feeOptions(stored: FeeMode): [FeeMode, string][] {
  const options: [FeeMode, string][] = [
    ["none", "Not deducted"],
    ["flat", "Flat percentage"],
  ]
  return stored === "actual" ? [...options, ["actual", "Actual fees"]] : options
}
