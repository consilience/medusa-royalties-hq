import { buildSnapshot, snapshotRowsToCsv } from "../../core/payload"
import { manualCutoffAt, refundCutoffFor, type Period } from "../../core/period"
import { addMinutesInZone } from "../../core/period/period"
import { AdminError } from "../admin/settings"
import { CLIENT_VERSION } from "../rhq/clientInfo"
import { toCoreSettings } from "../settings/settings"
import { pushHistory } from "./log"
import type { PushDeps } from "./push"
import { STATE_KEYS, type ConnectionRecord } from "./store"

export type CsvDownload = { filename: string; body: string; rowCount: number }

/**
 * The month as a push would build it, in RHQ's sales import template. For a
 * publisher who checks the figures, or imports by hand instead of pushing.
 * It reads the local history only, never RHQ: a store that never connects
 * can still export.
 *
 * Not refused above the API's row limit: that limit does not apply to a
 * file imported by hand, and a complete file is what is needed when a push
 * is too big.
 */
export async function periodCsv(deps: Pick<PushDeps, "store" | "loadPeriodInputs" | "now">, period: Period): Promise<CsvDownload> {
  const now = (deps.now ?? (() => new Date()))()
  const settings = await deps.store.currentSettings()
  if (!settings?.timezone) throw new AdminError(409, "settings_missing", "Save the settings first: the export uses them.")
  const core = toCoreSettings(settings)
  const record = await deps.store.readState<ConnectionRecord>(STATE_KEYS.connection)
  // The export reads the history of the recorded connection. After a token
  // change it cannot know whether that is still the right one, and building
  // without history would count again refunds already sent.
  if (record && "unconfirmed_since" in record) {
    throw new AdminError(409, "connection_unconfirmed", "The token changed, so the export cannot tell which connection's history to use. Use Test connection in the settings, then export again.")
  }
  const connection = record
  const history = connection ? pushHistory(await deps.store.listSnapshots(connection.id), { connectionId: connection.id }) : pushHistory([], { connectionId: 0 })
  // Rendered in the store's zone, as a push sends it, so the cut-off is the
  // same string either way.
  for (const [p, instant] of history.recordedCutoffs) history.recordedCutoffs.set(p, addMinutesInZone(instant, 0, core.timezone))
  // Manual mode: an unpushed month's cut-off is when it is pushed, so the
  // export shows it as if pushed now.
  if (core.pushMode === "manual" && !history.recordedCutoffs.has(period)) history.recordedCutoffs.set(period, manualCutoffAt(now.toISOString(), core.timezone))
  const refundCutoffAt = refundCutoffFor(period, core, history.recordedCutoffs)
  const inputs = await deps.loadPeriodInputs({
    period,
    settings,
    refundCutoffAt,
    history,
    saleContexts: (ids) => (connection ? deps.store.saleContexts(connection.id, ids) : Promise.resolve(new Map())),
  })
  const { payload } = buildSnapshot({
    period,
    orders: inputs.orders,
    orphanRefunds: inputs.orphanRefunds,
    refundsOnUnpaidOrders: inputs.refundsOnUnpaidOrders,
    products: inputs.products,
    settings: core,
    ...history,
    generatedAt: now.toISOString(),
    clientVersion: CLIENT_VERSION,
    maxRows: Number.MAX_SAFE_INTEGER,
    unlinedRefunds: "infer",
  })
  return {
    filename: `royalties-hq-${period}.csv`,
    // The connection's marketplace, so a hand import lands where the API's
    // months do; the platform's own until a push has read it.
    body: snapshotRowsToCsv(payload.rows, { period, marketplace: connection?.marketplace }),
    rowCount: payload.rows.length,
  }
}
