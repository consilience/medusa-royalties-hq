import { addMonths, comparePeriods, manuallyPushable, periodOfInstant, periodRange, type Period } from "../../core/period"
import type { PushStore } from "./store"

// Which months a person may push in manual mode, from this
// connection's own snapshots, which every push's handshake keeps in line
// with RHQ. Shared by the push step, which enforces it, and the status page,
// which offers a Push button for each.

export async function manuallyPushableMonths(
  store: Pick<PushStore, "listSnapshots">,
  args: { connectionId: number; timezone: string; startMonth?: Period },
  now: Date,
): Promise<{ pushable: Period[]; firstUnpushed: Period | null }> {
  const logs = (await store.listSnapshots(args.connectionId)).filter((l) => l.mode === "live" && l.pushed_at !== null)
  const accepted = new Set(logs.map((l) => l.period))
  const imported = new Set(logs.filter((l) => l.status === "imported").map((l) => l.period))
  const lastEnded = addMonths(periodOfInstant(now.toISOString(), args.timezone), -1)
  // Without a start month, the first accepted month, else last month: never
  // a guess further back, which would make a person push months nobody
  // asked for before the one they want.
  const start = args.startMonth ?? [...accepted].sort(comparePeriods)[0] ?? lastEnded
  // Orders are read when the month is built, so every month from the start can be read.
  const extracted = new Set(comparePeriods(start, lastEnded) <= 0 ? periodRange(start, lastEnded) : [])
  const pushable = manuallyPushable(now.toISOString(), { timezone: args.timezone, backfillStart: start, extracted, accepted, imported })
  const last = pushable.at(-1)
  return { pushable, firstUnpushed: last !== undefined && !accepted.has(last) ? last : null }
}
