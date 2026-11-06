import type { SaleContext } from "../../core/types"
import type { StoredSettings } from "../settings/settings"
import type { LoggedSnapshot } from "./log"

// What the push step reads and writes, as one interface over the module's
// tables (rhq_snapshot, rhq_push_attempt, rhq_sale_context, rhq_settings,
// rhq_state). The push logic runs against an in-memory store in unit tests
// and against the module service in Medusa; nothing here imports Medusa.
//
// Methods that must be atomic say so. Everything else is a single-row read
// or write, and the push lock keeps two pushes of the store from
// interleaving them.

export type SnapshotMode = "live" | "test"
export type SnapshotStatus = "built" | "staged" | "imported" | "rejected" | "failed"
export type AttemptMode = "live" | "test" | "dry_run"
export type AttemptTrigger = "scheduled" | "manual"
export type AttemptState = "prepared" | "sent" | "accepted" | "rejected" | "failed" | "unknown" | "refused" | "interrupted"
export type FrozenReason = "period_imported" | "refund_reported"

/** One rhq_snapshot row. */
export interface SnapshotRow extends LoggedSnapshot {
  id: string
  connection_id: number
  period: string
  mode: SnapshotMode
  status: SnapshotStatus
  refund_cutoff_at: Date
  content_hash: string
  generated_at: Date
  row_count: number
  totals: Record<string, string>
  last_http_status: number | null
  error_code: string | null
  attempts: number
  hold_back_reasons: string[] | null
  import_id: number | null
  import_url: string | null
  payload_sha256: string | null
  pushed_at: Date | null
  rhq_error_count: number | null
  rhq_error_summary: string | null
  rhq_error_reason: string | null
  rhq_checked_at: Date | null
}

export type SnapshotKey = { connectionId: number; period: string; mode: SnapshotMode }

/** What a write must carry to create the row if it does not exist yet. */
export type SnapshotData = Pick<SnapshotRow, "status" | "refund_cutoff_at" | "content_hash" | "generated_at" | "row_count" | "totals"> &
  Partial<Omit<SnapshotRow, "id" | "connection_id" | "period" | "mode" | "attempts">>

export type SnapshotPatch = Partial<Omit<SnapshotRow, "id" | "connection_id" | "period" | "mode" | "attempts">>

/**
 * What an accepted live push records, kept on the prepared attempt before the
 * body is sent. If the process dies after RHQ accepted but before the store
 * recorded it, the next push reads the month back and, when RHQ's
 * payload_sha256 matches the attempt's body_sha256, records exactly this.
 * Plain JSON: ids, strings and sale contexts (variant ids and prices only).
 */
export interface AcceptanceManifest {
  refund_cutoff_at: string
  generated_at: string
  content_hash: string
  row_count: number
  totals: Record<string, string>
  pushed_refund_ids: string[]
  reported_money_only_refund_ids: string[]
  applied_money_only_refund_ids: string[]
  pushed_order_ids: string[]
  refunded_orders_sold_elsewhere: string[]
  sale_contexts: Record<string, SaleContext>
}

/** One rhq_push_attempt row. */
export interface AttemptRow {
  id: string
  connection_id: number | null
  period: string
  mode: AttemptMode
  trigger: AttemptTrigger
  state: AttemptState
  started_at: Date
  finished_at: Date | null
  http_status: number | null
  problem_code: string | null
  problem_title: string | null
  problem_detail: string | null
  row_errors: Record<string, string[]> | null
  import_id: number | null
  /** RHQ's label: created, replaced, unchanged; "confirmed" after a read-back. */
  result: string | null
  content_hash: string | null
  body_sha256: string | null
  manifest: AcceptanceManifest | null
  warnings: unknown[] | null
  retry_at: Date | null
  /** Attempts so far in this logical push, this one included. */
  retry_count: number
}

export type AttemptCreate = Pick<AttemptRow, "period" | "mode" | "trigger" | "state" | "started_at"> & Partial<Omit<AttemptRow, "id">>
export type AttemptPatch = Partial<Omit<AttemptRow, "id" | "period" | "trigger" | "started_at">>

export interface StoredSaleContext {
  context: SaleContext
  frozen: boolean
}

export interface AcceptanceWrite {
  connectionId: number
  period: string
  attemptId: string
  attempt: AttemptPatch
  /** The live snapshot row as accepted; replaces the manifests whole. */
  snapshot: SnapshotData
  /**
   * Sale contexts to record, for the orders the accepted body carried only,
   * and never over a frozen one.
   */
  saleContexts: { captured: Readonly<Record<string, SaleContext>>; pushedOrderIds: readonly string[] }
  /** Orders sold elsewhere whose refunds this body carried: frozen now. */
  freeze: { orderIds: readonly string[]; reason: FrozenReason; at: Date }
}

export interface PushStore {
  /** The current settings version's data, or null before the first save. */
  currentSettings(): Promise<StoredSettings | null>
  readState<T = unknown>(key: string): Promise<T | null>
  writeState(key: string, value: unknown): Promise<void>

  listSnapshots(connectionId: number): Promise<SnapshotRow[]>
  findSnapshot(key: SnapshotKey): Promise<SnapshotRow | null>
  /** Creates or updates; `countAttempt` adds one to `attempts`. */
  upsertSnapshot(key: SnapshotKey, data: SnapshotData, opts: { countAttempt: boolean }): Promise<SnapshotRow>
  updateSnapshot(id: string, patch: SnapshotPatch, opts?: { countAttempt?: boolean }): Promise<void>
  /**
   * Updates only while the row still names this import and status, so a push
   * that replaced the import meanwhile is never labelled with the old one's
   * view. Returns whether it wrote.
   */
  updateSnapshotIf(id: string, expect: { import_id: number | null; status: SnapshotStatus }, patch: SnapshotPatch): Promise<boolean>

  createAttempt(data: AttemptCreate): Promise<AttemptRow>
  updateAttempt(id: string, patch: AttemptPatch): Promise<void>
  /** The latest attempt matching, by started_at then creation order. */
  latestAttempt(filter: { connectionId: number; period: string; mode: AttemptMode; states?: readonly AttemptState[] }): Promise<AttemptRow | null>
  /** Closes prepared or sent attempts started before `startedBefore`. Returns how many. */
  markInterrupted(startedBefore: Date, now: Date): Promise<number>

  /** Recorded sale contexts on this connection, by order id; orders without one are absent. */
  saleContexts(connectionId: number, orderIds: readonly string[]): Promise<Map<string, StoredSaleContext>>

  /**
   * Atomic: the attempt's outcome, the live snapshot with its manifests, the
   * sale contexts and the freezes, all or nothing. The store must never say a
   * push was accepted without also saying what it carried.
   */
  recordAcceptance(write: AcceptanceWrite): Promise<void>
  /** Atomic: a handshake's news about one month, and the freeze it implies. */
  syncSnapshot(id: string, patch: SnapshotPatch, freeze: { connectionId: number; orderIds: readonly string[]; reason: FrozenReason; at: Date } | null): Promise<void>

  /** Claims the once-a-minute manual import check; false while one ran within `intervalMs`. Atomic. */
  claimManualCheck(now: Date, intervalMs: number): Promise<boolean>
}

/** rhq_state keys the push step owns. */
/**
 * The connection record: the connection of the last live handshake, or the
 * mark a token change leaves until the next one confirms which connection
 * the new token belongs to.
 */
export type ConnectionRecord = { id: number; marketplace: string } | { unconfirmed_since: string }

/** The confirmed connection, or null before any handshake and while a token change is unconfirmed. */
export async function knownConnection(store: Pick<PushStore, "readState">): Promise<{ id: number; marketplace: string } | null> {
  const record = await store.readState<ConnectionRecord>(STATE_KEYS.connection)
  return record && "id" in record ? record : null
}

export const STATE_KEYS = {
  /** { origin, storeId }: recorded when sending is enabled. */
  deployment: "deployment",
  /** Set when a live push found the deployment changed; live pushes stay refused until a person clears it. */
  deploymentHold: "deployment_hold",
  /** A ConnectionRecord: the last live handshake's connection, or a token change's mark. */
  connection: "connection",
  manualCheckAt: "manual_check_at",
} as const
