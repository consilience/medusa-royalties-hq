import type { StoredSettings } from "../settings/settings"
import { STATE_KEYS, type AttemptRow, type PushStore, type SnapshotRow, type StoredSaleContext } from "./store"

type Row = Record<string, any>

/**
 * The module service's shared context: opaque here. Inside `transaction`, every
 * call that is part of the group must be handed it.
 */
type Ctx = object

/** The module service methods this store reads and writes through. */
export interface PushStoreService {
  currentSettingsVersion(): Promise<{ data: Record<string, unknown> } | null>
  readState<T = unknown>(key: string): Promise<T | null>
  writeState(key: string, value: unknown): Promise<void>
  transaction<T>(work: (ctx: Ctx) => Promise<T>): Promise<T>
  patchRows(
    entity: "RhqSnapshot" | "RhqPushAttempt" | "RhqSaleContext",
    where: Row,
    patch: Row,
    increment?: Record<string, number>,
    ctx?: Ctx,
  ): Promise<number>
  claimStateTime(key: string, at: Date, notAfter: Date): Promise<boolean>
  listRhqSnapshots(filters?: Row, config?: Row, ctx?: Ctx): Promise<Row[]>
  createRhqSnapshots(data: Row, ctx?: Ctx): Promise<Row>
  listRhqPushAttempts(filters?: Row, config?: Row, ctx?: Ctx): Promise<Row[]>
  createRhqPushAttempts(data: Row, ctx?: Ctx): Promise<Row>
  listRhqSaleContexts(filters?: Row, config?: Row, ctx?: Ctx): Promise<Row[]>
  createRhqSaleContexts(data: Row, ctx?: Ctx): Promise<Row>
}

const SNAPSHOT_FIELDS = [
  "id", "connection_id", "period", "mode", "status", "refund_cutoff_at", "content_hash", "generated_at", "row_count", "totals",
  "last_http_status", "error_code", "attempts", "hold_back_reasons", "import_id", "import_url", "payload_sha256",
  "pushed_refund_ids", "reported_money_only_refund_ids", "applied_money_only_refund_ids", "pushed_order_ids", "pushed_at",
  "rhq_error_count", "rhq_error_summary", "rhq_error_reason", "rhq_checked_at",
] as const

const ATTEMPT_FIELDS = [
  "id", "connection_id", "period", "mode", "trigger", "state", "started_at", "finished_at", "http_status", "problem_code",
  "problem_title", "problem_detail", "row_errors", "import_id", "result", "content_hash", "body_sha256", "manifest",
  "warnings", "retry_at", "retry_count",
] as const

const pick = <T>(row: Row, fields: readonly string[]): T => Object.fromEntries(fields.map((f) => [f, row[f] ?? null])) as T
const toSnapshot = (row: Row) => pick<SnapshotRow>(row, SNAPSHOT_FIELDS)
const toAttempt = (row: Row) => pick<AttemptRow>(row, ATTEMPT_FIELDS)

type Key = { connectionId: number; period: string; mode: string }

// The PushStore over the module's tables. Every write goes through the
// service's patchRows, never the generated update*, because those merge JSON
// fields into what is stored; and the two atomic groups run inside one
// service transaction, each call handed its context.
export function createModulePushStore(service: PushStoreService): PushStore {
  const findSnap = async (k: Key, ctx?: Ctx) => {
    const [row] = await service.listRhqSnapshots({ connection_id: k.connectionId, period: k.period, mode: k.mode }, {}, ctx)
    return row ?? null
  }
  const snapById = async (id: string, ctx?: Ctx) => {
    const [row] = await service.listRhqSnapshots({ id }, {}, ctx)
    if (!row) throw new Error(`no snapshot ${id}`)
    return row
  }
  const patchSnap = async (id: string, patch: Row, countAttempt: boolean, ctx?: Ctx) => {
    const n = await service.patchRows("RhqSnapshot", { id }, patch, countAttempt ? { attempts: 1 } : {}, ctx)
    if (n === 0) throw new Error(`no snapshot ${id}`)
  }
  const upsert = async (k: Key, data: Row, countAttempt: boolean, ctx: Ctx) => {
    const existing = await findSnap(k, ctx)
    if (!existing) {
      return service.createRhqSnapshots(
        { ...data, connection_id: k.connectionId, period: k.period, mode: k.mode, attempts: countAttempt ? 1 : 0 },
        ctx,
      )
    }
    await patchSnap(existing.id, data, countAttempt, ctx)
    return snapById(existing.id, ctx)
  }
  const freeze = async (connectionId: number, orderIds: readonly string[], reason: string, at: Date, ctx: Ctx) => {
    if (!orderIds.length) return
    // Only an unfrozen context freezes, so a frozen one keeps its first reason and time.
    await service.patchRows(
      "RhqSaleContext",
      { connection_id: connectionId, order_id: [...orderIds], frozen_at: null },
      { frozen_at: at, frozen_reason: reason },
      {},
      ctx,
    )
  }

  return {
    async currentSettings() {
      const row = await service.currentSettingsVersion()
      return row ? (row.data as StoredSettings) : null
    },
    readState: (key) => service.readState(key),
    writeState: (key, value) => service.writeState(key, value),

    async listSnapshots(connectionId) {
      return (await service.listRhqSnapshots({ connection_id: connectionId })).map(toSnapshot)
    },
    async findSnapshot(k) {
      const row = await findSnap(k)
      return row ? toSnapshot(row) : null
    },
    async upsertSnapshot(k, data, { countAttempt }) {
      return toSnapshot(await service.transaction((ctx) => upsert(k, data, countAttempt, ctx)))
    },
    async updateSnapshot(id, patch, opts = {}) {
      await patchSnap(id, patch, opts.countAttempt === true)
    },
    async updateSnapshotIf(id, expect, patch) {
      return (await service.patchRows("RhqSnapshot", { id, import_id: expect.import_id, status: expect.status }, patch)) > 0
    },

    async createAttempt(data) {
      return toAttempt(await service.createRhqPushAttempts(data))
    },
    async updateAttempt(id, patch) {
      if ((await service.patchRows("RhqPushAttempt", { id }, patch)) === 0) throw new Error(`no attempt ${id}`)
    },
    async latestAttempt({ connectionId, period, mode, states }) {
      // created_at, then id, stand in for creation order on a started_at tie.
      // Both are only as fine as a millisecond: two attempts created in the
      // same one with the same started_at may come back in either order.
      const [row] = await service.listRhqPushAttempts(
        { connection_id: connectionId, period, mode, ...(states ? { state: [...states] } : {}) },
        { order: { started_at: "DESC", created_at: "DESC", id: "DESC" }, take: 1 },
      )
      return row ? toAttempt(row) : null
    },
    async markInterrupted(startedBefore, now) {
      return service.patchRows(
        "RhqPushAttempt",
        { state: ["prepared", "sent"], finished_at: null, started_at: { $lt: startedBefore } },
        { state: "interrupted", finished_at: now },
      )
    },

    async saleContexts(connectionId, orderIds) {
      const out = new Map<string, StoredSaleContext>()
      if (!orderIds.length) return out
      for (const r of await service.listRhqSaleContexts({ connection_id: connectionId, order_id: [...orderIds] })) {
        out.set(r.order_id, { context: r.context, frozen: r.frozen_at != null })
      }
      return out
    },

    async recordAcceptance(w) {
      await service.transaction(async (ctx) => {
        if ((await service.patchRows("RhqPushAttempt", { id: w.attemptId }, w.attempt, {}, ctx)) === 0) {
          throw new Error(`no attempt ${w.attemptId}`)
        }
        await upsert({ connectionId: w.connectionId, period: w.period, mode: "live" }, w.snapshot, true, ctx)
        const carried = new Set(w.saleContexts.pushedOrderIds)
        const orderIds = Object.keys(w.saleContexts.captured).filter((id) => carried.has(id))
        const existing = orderIds.length
          ? await service.listRhqSaleContexts({ connection_id: w.connectionId, order_id: orderIds }, {}, ctx)
          : []
        const byOrder = new Map(existing.map((r) => [r.order_id, r]))
        for (const orderId of orderIds) {
          const context = w.saleContexts.captured[orderId]
          const row = byOrder.get(orderId)
          if (row?.frozen_at) continue
          // Guarded on frozen_at too, in case a freeze landed since the read.
          if (row) await service.patchRows("RhqSaleContext", { id: row.id, frozen_at: null }, { context }, {}, ctx)
          else await service.createRhqSaleContexts({ connection_id: w.connectionId, order_id: orderId, context }, ctx)
        }
        await freeze(w.connectionId, w.freeze.orderIds, w.freeze.reason, w.freeze.at, ctx)
      })
    },
    async syncSnapshot(id, patch, f) {
      await service.transaction(async (ctx) => {
        await patchSnap(id, patch, false, ctx)
        if (f) await freeze(f.connectionId, f.orderIds, f.reason, f.at, ctx)
      })
    },

    async claimManualCheck(now, intervalMs) {
      return service.claimStateTime(STATE_KEYS.manualCheckAt, now, new Date(now.getTime() - intervalMs))
    },
  }
}
