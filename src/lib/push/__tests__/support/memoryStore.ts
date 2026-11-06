import type { SaleContext } from "../../../../core/types"
import type { StoredSettings } from "../../../settings/settings"
import { STATE_KEYS, type AttemptRow, type FrozenReason, type PushStore, type SnapshotRow } from "../../store"

// The PushStore in memory, for unit tests. Atomic methods work on a copy of
// the whole state and swap it in only when they finish, so a failure planted
// part-way through (failNext) leaves nothing behind, as a database
// transaction would.

export interface SaleContextRecord {
  connection_id: number
  order_id: string
  context: SaleContext
  frozen_at: Date | null
  frozen_reason: FrozenReason | null
}

interface State {
  settings: StoredSettings[]
  state: Map<string, unknown>
  snapshots: SnapshotRow[]
  attempts: AttemptRow[]
  saleContexts: SaleContextRecord[]
}

// Hand-rolled rather than structuredClone: that builds its Dates in Node's
// own realm, which Jest's expect.any(Date) does not recognise.
function clone<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as T
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, clone(x)])) as T
  if (Array.isArray(v)) return v.map(clone) as T
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T
  return v
}

export type MemoryStore = PushStore & {
  data: State
  /** Throws inside the next call of `method`, after it has made some of its writes. */
  failNext(method: "recordAcceptance" | "syncSnapshot" | "updateAttempt", error?: Error): void
  saveSettings(s: StoredSettings): void
}

export function memoryStore(initial: { settings?: StoredSettings } = {}): MemoryStore {
  let s: State = {
    settings: initial.settings ? [clone(initial.settings)] : [],
    state: new Map(),
    snapshots: [],
    attempts: [],
    saleContexts: [],
  }
  let seq = 0
  const failures = new Map<string, Error>()
  const takeFailure = (method: string) => {
    const e = failures.get(method)
    failures.delete(method)
    return e
  }
  const id = (prefix: string) => `${prefix}_${String(++seq).padStart(4, "0")}`

  const atomically = async (method: string, work: (draft: State) => void) => {
    const draft = clone(s)
    work(draft)
    const failure = takeFailure(method)
    if (failure) throw failure
    s = draft
  }

  const findSnap = (st: State, k: { connectionId: number; period: string; mode: string }) =>
    st.snapshots.find((r) => r.connection_id === k.connectionId && r.period === k.period && r.mode === k.mode) ?? null

  const upsert = (st: State, k: { connectionId: number; period: string; mode: "live" | "test" }, data: any, countAttempt: boolean) => {
    const existing = findSnap(st, k)
    if (existing) {
      Object.assign(existing, clone(data))
      if (countAttempt) existing.attempts += 1
      return existing
    }
    const row: SnapshotRow = {
      id: id("rhqsnap"),
      connection_id: k.connectionId,
      period: k.period,
      mode: k.mode,
      last_http_status: null,
      error_code: null,
      attempts: countAttempt ? 1 : 0,
      hold_back_reasons: null,
      import_id: null,
      import_url: null,
      payload_sha256: null,
      pushed_refund_ids: null,
      reported_money_only_refund_ids: null,
      applied_money_only_refund_ids: null,
      pushed_order_ids: null,
      pushed_at: null,
      rhq_error_count: null,
      rhq_error_summary: null,
      rhq_error_reason: null,
      rhq_checked_at: null,
      ...clone(data),
    }
    st.snapshots.push(row)
    return row
  }

  const freeze = (st: State, connectionId: number, orderIds: readonly string[], reason: FrozenReason, at: Date) => {
    const ids = new Set(orderIds)
    for (const c of st.saleContexts) {
      // Only a recorded context freezes, and an already frozen one keeps its
      // first reason and time.
      if (c.connection_id === connectionId && ids.has(c.order_id) && c.frozen_at === null) {
        c.frozen_at = at
        c.frozen_reason = reason
      }
    }
  }

  const store: MemoryStore = {
    get data() {
      return s
    },
    failNext(method, error = new Error(`planted ${method} failure`)) {
      failures.set(method, error)
    },
    saveSettings(settings) {
      s.settings.push(clone(settings))
    },

    async currentSettings() {
      const last = s.settings[s.settings.length - 1]
      return last ? clone(last) : null
    },
    async readState<T>(key: string) {
      return s.state.has(key) ? (clone(s.state.get(key)) as T) : null
    },
    async writeState(key, value) {
      s.state.set(key, clone(value))
    },

    async listSnapshots(connectionId) {
      return clone(s.snapshots.filter((r) => r.connection_id === connectionId))
    },
    async findSnapshot(k) {
      const r = findSnap(s, k)
      return r ? clone(r) : null
    },
    async upsertSnapshot(k, data, { countAttempt }) {
      return clone(upsert(s, k, data, countAttempt))
    },
    async updateSnapshot(snapId, patch, opts = {}) {
      const r = s.snapshots.find((x) => x.id === snapId)
      if (!r) throw new Error(`no snapshot ${snapId}`)
      Object.assign(r, clone(patch))
      if (opts.countAttempt) r.attempts += 1
    },
    async updateSnapshotIf(snapId, expect, patch) {
      const r = s.snapshots.find((x) => x.id === snapId)
      if (!r || r.import_id !== expect.import_id || r.status !== expect.status) return false
      Object.assign(r, clone(patch))
      return true
    },

    async createAttempt(data) {
      const row: AttemptRow = {
        id: id("rhqatt"),
        connection_id: null,
        finished_at: null,
        http_status: null,
        problem_code: null,
        problem_title: null,
        problem_detail: null,
        row_errors: null,
        import_id: null,
        result: null,
        content_hash: null,
        body_sha256: null,
        manifest: null,
        warnings: null,
        retry_at: null,
        retry_count: 0,
        ...clone(data),
      }
      s.attempts.push(row)
      return clone(row)
    },
    async updateAttempt(attemptId, patch) {
      const failure = takeFailure("updateAttempt")
      if (failure) throw failure
      const r = s.attempts.find((x) => x.id === attemptId)
      if (!r) throw new Error(`no attempt ${attemptId}`)
      Object.assign(r, clone(patch))
    },
    async latestAttempt({ connectionId, period, mode, states }) {
      let best: AttemptRow | null = null
      for (const a of s.attempts) {
        if (a.connection_id !== connectionId || a.period !== period || a.mode !== mode) continue
        if (states && !states.includes(a.state)) continue
        // Ties on started_at go to the later row, as an auto-increment would.
        if (!best || a.started_at.getTime() >= best.started_at.getTime()) best = a
      }
      return best ? clone(best) : null
    },
    async markInterrupted(startedBefore, now) {
      let n = 0
      for (const a of s.attempts) {
        if ((a.state === "prepared" || a.state === "sent") && a.finished_at === null && a.started_at < startedBefore) {
          a.state = "interrupted"
          a.finished_at = now
          n += 1
        }
      }
      return n
    },

    async saleContexts(connectionId, orderIds) {
      const ids = new Set(orderIds)
      const out = new Map()
      for (const c of s.saleContexts) {
        if (c.connection_id === connectionId && ids.has(c.order_id)) {
          out.set(c.order_id, { context: clone(c.context), frozen: c.frozen_at !== null })
        }
      }
      return out
    },

    async recordAcceptance(w) {
      await atomically("recordAcceptance", (st) => {
        const a = st.attempts.find((x) => x.id === w.attemptId)
        if (!a) throw new Error(`no attempt ${w.attemptId}`)
        Object.assign(a, clone(w.attempt))
        upsert(st, { connectionId: w.connectionId, period: w.period, mode: "live" }, w.snapshot, true)
        const carried = new Set(w.saleContexts.pushedOrderIds)
        for (const [orderId, context] of Object.entries(w.saleContexts.captured)) {
          if (!carried.has(orderId)) continue
          const existing = st.saleContexts.find((c) => c.connection_id === w.connectionId && c.order_id === orderId)
          if (existing?.frozen_at) continue
          if (existing) existing.context = clone(context)
          else st.saleContexts.push({ connection_id: w.connectionId, order_id: orderId, context: clone(context), frozen_at: null, frozen_reason: null })
        }
        freeze(st, w.connectionId, w.freeze.orderIds, w.freeze.reason, w.freeze.at)
      })
    },
    async syncSnapshot(snapId, patch, f) {
      await atomically("syncSnapshot", (st) => {
        const r = st.snapshots.find((x) => x.id === snapId)
        if (!r) throw new Error(`no snapshot ${snapId}`)
        Object.assign(r, clone(patch))
        if (f) freeze(st, f.connectionId, f.orderIds, f.reason, f.at)
      })
    },

    async claimManualCheck(now, intervalMs) {
      const last = s.state.get(STATE_KEYS.manualCheckAt) as string | undefined
      if (last !== undefined && now.getTime() - new Date(last).getTime() < intervalMs) return false
      s.state.set(STATE_KEYS.manualCheckAt, now.toISOString())
      return true
    },
  }
  return store
}
