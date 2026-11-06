import { createHash } from "node:crypto"

import type { CoreOrder, CoreRefund, ProductConfig } from "../../../../core/types"
import { createHandshakeCache } from "../../../rhq/client"
import { BASE, connectionBody, fakeRhq, LIVE_TOKEN, snapshotData, type Reply, type SentRequest } from "../../../rhq/__tests__/support/fakeRhq"
import { DEFAULT_SETTINGS, type StoredSettings } from "../../../settings/settings"
import type { LoadPeriodInputs, PushDeps, PushLock, PushNotice } from "../../push"
import { STATE_KEYS } from "../../store"
import { memoryStore, type MemoryStore } from "./memoryStore"

// The push test world, over the in-memory store: a store with sending on and a live token, one
// included product with an ISBN, and one August order for it.

export { BASE, LIVE_TOKEN }

export const ISBN = "9780306406157"
export const V = (n: number) => `variant_${String(n).padStart(2, "0")}`
export const ORIGIN = "https://shop.example.test"
export const MEDUSA_STORE_ID = "store_01JC"

export function settingsFor(overrides: Partial<StoredSettings> = {}): StoredSettings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    base_url: BASE,
    timezone: "Europe/London",
    sale_country: "GB",
    commission_percent: "10",
    push_day: 15,
    isbn_source: "barcode",
    ...overrides,
  }
}

export type RhqPeriods = { period: string; status: "staged" | "rejected" | "imported"; refund_cutoff_at: string | null; import_id: number | null }[]

/**
 * A fake RHQ that answers the handshake from `periods` (mutable, so a test
 * can move a month to imported) and every other request from `writes` in order.
 */
export function rhqStub(opts: { periods?: RhqPeriods; writes?: Reply[]; tokenMode?: "live" | "test"; handshake?: Reply; connection?: Record<string, unknown> } = {}) {
  const state = { periods: opts.periods ?? [], writes: [...(opts.writes ?? [])], connection: { ...opts.connection } }
  const rhq = fakeRhq((request: SentRequest): Reply => {
    if (request.method === "GET" && request.url.endsWith("/connection")) {
      return (
        opts.handshake ?? {
          status: 200,
          body: connectionBody({
            periods: state.periods,
            token: { mode: opts.tokenMode ?? "live", expires_at: "2027-09-01T00:00:00Z" },
            ...state.connection,
          }),
        }
      )
    }
    const next = state.writes.shift()
    if (!next) throw new Error(`unexpected ${request.method} ${request.url}`)
    return next
  })
  return { ...rhq, state }
}
export type RhqStub = ReturnType<typeof rhqStub>

export const accepted = (result: "created" | "replaced" | "unchanged", overrides: Record<string, unknown> = {}): Reply => ({
  status: result === "unchanged" ? 200 : 202,
  body: { data: snapshotData({ result, ...overrides }) },
})

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
export const puts = (rhq: RhqStub) => rhq.sent.filter((r) => r.method === "PUT")
export const paths = (rhq: RhqStub) => rhq.sent.map((r) => `${r.method} ${new URL(r.url).pathname}`)

/** A lock shaped like Modules.LOCKING's execute: a held key fails at once. */
export function memoryLock(): PushLock & { held: Set<string>; calls: { key: string; args: unknown }[] } {
  const held = new Set<string>()
  const calls: { key: string; args: unknown }[] = []
  return {
    held,
    calls,
    async execute(key, job, args) {
      calls.push({ key, args })
      if (held.has(key)) throw new Error("Timed-out acquiring lock.")
      held.add(key)
      try {
        return await job()
      } finally {
        held.delete(key)
      }
    },
  }
}

let seq = 0

/** What the store has sold: CoreOrders as the Medusa reader would hand them over. */
export function ledger() {
  const orders: CoreOrder[] = []
  const products = new Map<string, ProductConfig>()
  const product = (n: number, over: Partial<ProductConfig> = {}) => {
    products.set(V(n), {
      variantId: V(n),
      included: true,
      rhqProductId: null,
      isbnSourceValue: null,
      sku: null,
      asin: null,
      title: `Book ${n}`,
      regularUnitPrice: null,
      bundleComponents: null,
      ...over,
    })
  }
  const order = (o: { paidAt: string; lines: { variant: number; price: bigint; quantity?: number }[]; id?: string }) => {
    seq += 1
    const id = o.id ?? `order_${String(seq).padStart(4, "0")}`
    const core: CoreOrder = {
      id,
      paidAt: o.paidAt,
      currency: "GBP",
      financialStatus: "paid",
      test: false,
      taxesIncluded: false,
      lines: o.lines.map((l, i) => ({
        id: `${id}_line_${i}`,
        variantId: V(l.variant),
        productId: `prod_${l.variant}`,
        title: `Book ${l.variant}`,
        sku: null,
        barcode: null,
        quantity: l.quantity ?? 1,
        originalUnitPrice: l.price,
        discountTotal: 0n,
        tax: 0n,
        isGiftCard: false,
        requiresShipping: true,
        group: null,
        regularUnitPrice: null,
      })),
      shipping: { amount: 0n, tax: 0n },
      fee: null,
      refunds: [],
      cancelledAt: null,
    }
    orders.push(core)
    return core
  }
  /** A Medusa refund: cash only, no lines. */
  const refund = (orderId: string, r: { createdAt: string; amount: bigint }): CoreRefund => {
    seq += 1
    const o = orders.find((x) => x.id === orderId)
    if (!o) throw new Error(`no order ${orderId}`)
    const row: CoreRefund = { id: `ref_${String(seq).padStart(4, "0")}`, createdAt: r.createdAt, lines: [], shipping: { amount: 0n, tax: 0n }, unallocatedAmount: r.amount }
    o.refunds.push(row)
    const refunded = o.refunds.reduce((s, x) => s + (x.unallocatedAmount ?? 0n), 0n)
    const total = o.lines.reduce((s, l) => s + l.originalUnitPrice * BigInt(l.quantity), 0n)
    o.financialStatus = refunded >= total ? "refunded" : "partially_refunded"
    return row
  }
  const orphanRefunds: { orderId: string; currency: string; refund: CoreRefund }[] = []
  return { orders, products, product, order, refund, orphanRefunds }
}
export type Ledger = ReturnType<typeof ledger>

/** The fake loader: the whole ledger, with each order's recorded sale context. */
export function loaderOf(l: Ledger, seen: Parameters<LoadPeriodInputs>[0][] = []): LoadPeriodInputs {
  return async (args) => {
    seen.push(args)
    const contexts = await args.saleContexts(l.orders.map((o) => o.id))
    return {
      orders: l.orders.map((o) => {
        const c = contexts.get(o.id)
        return { ...o, saleContext: c?.context ?? null, saleContextFrozen: c?.frozen ?? false }
      }),
      orphanRefunds: l.orphanRefunds,
      products: l.products,
    }
  }
}

export interface PushWorld {
  store: MemoryStore
  deps: PushDeps
  ledger: Ledger
  orderId: string
  lock: ReturnType<typeof memoryLock>
  logs: Record<string, unknown>[]
  notices: PushNotice[]
  loads: Parameters<LoadPeriodInputs>[0][]
  setNow(iso: string): void
}

export function pushWorld(opts: { rhq: RhqStub; settings?: Partial<StoredSettings>; now?: string; storeId?: string | null; token?: string; startMonth?: string }): PushWorld {
  const store = memoryStore({ settings: settingsFor(opts.settings) })
  // Recorded when sending was switched on, as the admin will.
  void store.writeState(STATE_KEYS.deployment, { origin: ORIGIN, storeId: MEDUSA_STORE_ID })
  const l = ledger()
  l.product(1, { isbnSourceValue: ISBN, title: "The Book" })
  const o = l.order({ paidAt: "2026-08-10T10:00:00Z", lines: [{ variant: 1, price: 1000n, quantity: 2 }] })
  let now = new Date(opts.now ?? "2026-09-20T12:00:00.000Z")
  const clock = () => now
  const logs: Record<string, unknown>[] = []
  const notices: PushNotice[] = []
  const loads: Parameters<LoadPeriodInputs>[0][] = []
  const lock = memoryLock()
  const deps: PushDeps = {
    store,
    lock,
    loadPeriodInputs: loaderOf(l, loads),
    token: async () => opts.token ?? LIVE_TOKEN,
    storeId: opts.storeId === undefined ? MEDUSA_STORE_ID : opts.storeId,
    deployment: { origin: ORIGIN },
    startMonth: opts.startMonth ?? "2026-07",
    now: clock,
    random: () => 0.5,
    logger: (e) => logs.push(e),
    notify: (n) => {
      notices.push(n)
    },
    rhq: { fetch: opts.rhq.fetch, now: clock, handshakeCache: createHandshakeCache() },
  }
  return {
    store,
    deps,
    ledger: l,
    orderId: o.id,
    lock,
    logs,
    notices,
    loads,
    setNow: (iso) => {
      now = new Date(iso)
    },
  }
}
