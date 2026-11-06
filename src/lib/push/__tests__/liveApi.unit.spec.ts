import { payloadHash } from "../../hash/payloadHash"
import { PROBLEMS, snapshotData } from "../../rhq/__tests__/support/fakeRhq"
import { pushPeriod } from "../push"
import { STATE_KEYS } from "../store"
import { accepted, MEDUSA_STORE_ID, puts, pushWorld, rhqStub, sha256, type RhqStub } from "./support/world"

// The push step against the live API's features:
// store identity, the connection codes, per-install limits, gzip,
// the receipt hash, the backfill start, and what RHQ says about a staged
// month.

const live = { mode: "live", trigger: "scheduled" } as const
const manual = { mode: "live", trigger: "manual" } as const
const CONN = 7

const LIMITS = {
  max_rows: 5000,
  max_body_bytes: 5242880,
  max_inflated_body_bytes: 5242880,
  max_json_values: 220000,
  max_json_containers: 22500,
  rows_per_day: 100000,
  writes_per_minute: 30,
  writes_per_day: 1000,
  reads_per_minute: 120,
}
const api = (features: string[], limits: Partial<typeof LIMITS> = {}) => ({ api: { features, limits: { ...LIMITS, ...limits } } })

const bodyOf = (request: { body: string | null }) => JSON.parse(request.body!) as Record<string, unknown>
const liveLog = (w: ReturnType<typeof pushWorld>, period = "2026-08") => w.store.findSnapshot({ connectionId: CONN, period, mode: "live" })

describe("store identity", () => {
  it("sends the Medusa store id as store.id where the install lists store_id, and hashes it with the rest", async () => {
    const rhq = rhqStub({ writes: [accepted("created")], connection: api(["store_id"]) })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    const body = bodyOf(puts(rhq)[0]!)
    expect(body.store).toEqual({ id: `medusa:${MEDUSA_STORE_ID}` })
    expect((await liveLog(w))!.content_hash).toBe(payloadHash(body))
  })

  it("sends no store where the install does not list store_id", async () => {
    const rhq = rhqStub({ writes: [accepted("created")], connection: api([]) })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(bodyOf(puts(rhq)[0]!)).not.toHaveProperty("store")
  })

  it("refuses, sending nothing, while the store's id is unknown", async () => {
    const rhq = rhqStub({ connection: api(["store_id"]) })
    const w = pushWorld({ rhq, storeId: null })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "refused", problem: { code: "store_id_unknown" } })
    expect(puts(rhq)).toEqual([])
  })

  it("re-sends a staged month once the install starts listing store_id, so it binds", async () => {
    const rhq = rhqStub({ writes: [accepted("created"), accepted("replaced")], connection: api([]) })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    rhq.state.periods = [{ period: "2026-08", status: "staged", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342 }]
    rhq.state.connection = api(["store_id"])
    w.setNow("2026-09-21T12:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted", result: "replaced" })
    expect(bodyOf(puts(rhq)[1]!).store).toEqual({ id: `medusa:${MEDUSA_STORE_ID}` })
  })
})

describe("connection codes", () => {
  it.each([
    ["platform_mismatch", PROBLEMS.platformMismatch()],
    ["store_mismatch", PROBLEMS.storeMismatch()],
  ])("%s stops the run for a person, is never retried and never marks the month rejected", async (code, body) => {
    const rhq = rhqStub({ writes: [{ status: 409, body }] })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "problem", problem: { code }, retryAt: null, scope: "connection", stop: true })
    expect(w.store.data.attempts[0]!.state).toBe("failed")
    expect((await liveLog(w))!.status).toBe("failed")
    expect(w.notices).toEqual([expect.objectContaining({ kind: "problem", stop: true })])
  })
})

describe("per-install limits", () => {
  function twoRowWorld(rhq: RhqStub) {
    const w = pushWorld({ rhq })
    w.ledger.product(2, { sku: "SKU-2" })
    w.ledger.order({ paidAt: "2026-08-11T10:00:00Z", lines: [{ variant: 2, price: 500n }] })
    return w
  }

  it("refuses over the install's max_rows before sending, and sends once the install allows it", async () => {
    const rhq = rhqStub({ writes: [accepted("created")], connection: api(["store_id"], { max_rows: 1 }) })
    const w = twoRowWorld(rhq)
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "problem", problem: { code: "too_many_rows" }, retryAt: null })
    // The same content stays refused while the limit stands…
    w.setNow("2026-09-21T12:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "already_rejected" })
    expect(puts(rhq)).toEqual([])
    // …and goes once the install raises it.
    rhq.state.connection = api(["store_id"], { max_rows: 5000 })
    w.setNow("2026-09-22T12:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted" })
  })

  it("refuses a body over the install's value budget as payload_too_large, sending nothing", async () => {
    const rhq = rhqStub({ connection: api(["store_id"], { max_json_values: 20 }) })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "problem", problem: { code: "payload_too_large" } })
    expect(puts(rhq)).toEqual([])
  })

  it("refuses a body over the install's byte limit, sending nothing", async () => {
    const rhq = rhqStub({ connection: api([], { max_body_bytes: 200 }) })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "problem", problem: { code: "payload_too_large" } })
    expect(puts(rhq)).toEqual([])
  })
})

describe("gzip", () => {
  it("compresses where the install lists gzip; RHQ sees the same JSON", async () => {
    const rhq = rhqStub({ writes: [accepted("created")], connection: api(["store_id", "gzip"]) })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    const put = puts(rhq)[0]!
    expect(put.compressed).toBe(true)
    expect((await liveLog(w))!.content_hash).toBe(payloadHash(bodyOf(put)))
    // The receipt is of the inflated JSON, so the hash recorded is too.
    expect(w.store.data.attempts[0]!.body_sha256).toBe(sha256(put.body!))
  })

  it("sends plain JSON where it does not", async () => {
    const rhq = rhqStub({ writes: [accepted("created")], connection: api(["store_id"]) })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(puts(rhq)[0]!.compressed).toBe(false)
  })
})

describe("backfill start", () => {
  it("skips a scheduled push of a month before the connection's backfill start; Push now still sends it", async () => {
    const rhq = rhqStub({ writes: [accepted("created")], connection: { backfill_start_month: "2026-09" } })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "before_backfill_start" })
    expect(puts(rhq)).toEqual([])
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "accepted" })
  })
})

describe("what RHQ says about a staged month", () => {
  it("keeps the hold-back reasons and the import link, and the connection's marketplace", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { hold_back_reasons: ["no_baseline"] })] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(await liveLog(w)).toMatchObject({ hold_back_reasons: ["no_baseline"], import_url: "https://acme.royaltieshq.com/imports/342" })
    expect(await w.store.readState(STATE_KEYS.connection)).toEqual({ id: CONN, marketplace: "Acme Shop" })
  })

  it("clears the reasons when the month is imported, and the link when the import changes", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { hold_back_reasons: ["no_baseline"] })] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    const imported = { period: "2026-08", status: "imported" as const, refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342 }
    rhq.state.periods = [imported]
    w.setNow("2026-09-21T12:00:00.000Z")
    await pushPeriod(w.deps, "2026-08", live)
    expect(await liveLog(w)).toMatchObject({ status: "imported", hold_back_reasons: [], import_url: "https://acme.royaltieshq.com/imports/342" })
    rhq.state.periods = [{ ...imported, status: "staged", import_id: null }]
    w.setNow("2026-09-22T12:00:00.000Z")
    rhq.state.writes.push(
      accepted("replaced", {
        import_id: 350,
        links: { self: "https://acme.royaltieshq.com/api/v1/sales-snapshots/2026-08", import: "https://acme.royaltieshq.com/imports/350" },
      }),
    )
    await pushPeriod(w.deps, "2026-08", manual)
    expect(await liveLog(w)).toMatchObject({ import_id: 350, import_url: "https://acme.royaltieshq.com/imports/350" })
  })

  it("leaves live snapshots alone on a test-mode handshake", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    const tested = rhqStub({
      tokenMode: "test",
      periods: [{ period: "2026-08", status: "imported", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342 }],
      writes: [{ status: 202, body: { data: snapshotData({ result: "created", import_id: null }), mode: "test" } }],
    })
    w.deps.rhq = { ...w.deps.rhq, fetch: tested.fetch, handshakeCache: undefined }
    await pushPeriod(w.deps, "2026-08", { mode: "validate", trigger: "manual" })
    expect((await liveLog(w))!.status).toBe("staged")
  })
})

describe("the receipt hash after an unreadable 2xx", () => {
  const garbled = { status: 202, body: "<html>proxy says ok</html>", raw: true }

  async function readBackWith(payloadSha: (sentBody: string) => unknown) {
    const rhq = rhqStub({ writes: [garbled] })
    const w = pushWorld({ rhq })
    // The read-back answers from what was actually sent.
    rhq.state.writes.push({
      status: 200,
      raw: true,
      get body() {
        const data: Record<string, unknown> = snapshotData({ received_at: "2026-09-20T12:00:00Z", counts: { rows: 1, errors: 0, warnings: 0 } })
        const value = payloadSha(puts(rhq)[0]!.body!)
        if (value === undefined) delete data.payload_sha256
        else data.payload_sha256 = value
        return { data }
      },
    })
    const outcome = await pushPeriod(w.deps, "2026-08", live)
    return { outcome, attempt: w.store.data.attempts[0]! }
  }

  it("confirms when RHQ's hash is the hash of what was sent", async () => {
    const { outcome, attempt } = await readBackWith(sha256)
    expect(outcome).toMatchObject({ kind: "accepted" })
    expect(attempt).toMatchObject({ state: "accepted", result: "confirmed" })
  })

  it("does not confirm when RHQ holds other bytes", async () => {
    expect((await readBackWith(() => "f".repeat(64))).attempt.state).toBe("unknown")
  })

  it("does not confirm when RHQ says it holds no receipt (null)", async () => {
    expect((await readBackWith(() => null)).attempt.state).toBe("unknown")
  })

  it("falls back to matching the payload for an install that sends no hash", async () => {
    expect((await readBackWith(() => undefined)).attempt.result).toBe("confirmed")
  })

  it("reads back a 2xx whose body broke off, too", async () => {
    const rhq = rhqStub({ writes: [] })
    const w = pushWorld({ rhq })
    const realFetch = w.deps.rhq!.fetch!
    let first = true
    w.deps.rhq!.fetch = async (url, init) => {
      if (init.method === "PUT" && first) {
        first = false
        await realFetch(url, init).catch(() => {})
        return {
          status: 202,
          headers: new Headers({ "Content-Type": "application/json" }),
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new TypeError("terminated"))
            },
          }),
          text: async () => "",
        }
      }
      return realFetch(url, init)
    }
    rhq.state.writes.push(
      // Swallowed by the PUT above.
      accepted("created"),
      {
        status: 200,
        raw: true,
        get body() {
          return { data: snapshotData({ received_at: "2026-09-20T12:00:00Z", counts: { rows: 1, errors: 0, warnings: 0 }, payload_sha256: sha256(puts(rhq)[0]!.body!) }) }
        },
      },
    )
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted" })
    expect(w.store.data.attempts[0]!.result).toBe("confirmed")
  })
})
