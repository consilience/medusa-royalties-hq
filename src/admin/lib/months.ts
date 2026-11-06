import type { MonthLine } from "./api"

/**
 * The months that offer Push now. Oldest first, in either mode: a later month
 * pushed before an earlier unsent one would fix its cut-off and late sales out
 * of order. Months come newest first. A month RHQ imported is never re-pushed.
 */
export function pushableMonths(months: readonly Pick<MonthLine, "period" | "status">[], view: { enabled: boolean }): Set<string> {
  if (!view.enabled) return new Set()
  const oldestUnsent = [...months].reverse().find((x) => x.status === null)?.period
  return new Set(months.filter((x) => x.status !== "imported" && (x.status !== null || x.period === oldestUnsent)).map((x) => x.period))
}

/** The Sent column's row count; blank for a month never sent. */
export function rowCount(n: number | null): string {
  if (n === null) return ""
  return n === 1 ? "1 row" : `${n} rows`
}
