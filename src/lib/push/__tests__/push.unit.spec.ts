import { canonicalJson } from "../../../core/payload"
import { payloadHash } from "../../hash/payloadHash"
import { connectionBody, PROBLEMS, snapshotData, TEST_TOKEN } from "../../rhq/__tests__/support/fakeRhq"
import { markInterruptedAttempts, pushPeriod, PUSH_LOCK_KEY } from "../push"
import { accepted, ISBN, paths, puts, pushWorld, rhqStub, settingsFor, sha256 } from "./support/world"

// The push step, over the
// in-memory store and a fake RHQ that checks every request:
// what is sent, what is recorded, and what is never recorded (test mode,
// dry runs).

const live = { mode: "live", trigger: "scheduled" } as const
const manual = { mode: "live", trigger: "manual" } as const
const validate = { mode: "validate", trigger: "manual" } as const
const CONN = 7

function bodyOf(request: { body: string | null }) {
  return JSON.parse(request.body!) as { generated_at: string; settings: { refund_cutoff_at: string }; rows: unknown[] }
}

const liveSnap = (w: ReturnType<typeof pushWorld>, period = "2026-08") => w.store.findSnapshot({ connectionId: CONN, period, mode: "live" })
const attempts = (w: ReturnType<typeof pushWorld>) => w.store.data.attempts

describe("pushPeriod: live pushes", () => {
  it("hands RHQ the period and records the accepted push in one go", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })

    const outcome = await pushPeriod(w.deps, "2026-08", live)

    expect(paths(rhq)).toEqual(["GET /api/v1/connection", "PUT /api/v1/sales-snapshots/2026-08"])
    const body = bodyOf(rhq.sent[1]!)
    expect(body.rows).toHaveLength(1)
    // The scheduled cut-off, in the store's zone.
    expect(body.settings.refund_cutoff_at).toBe("2026-09-15T00:00:00+01:00")
    expect(outcome).toMatchObject({ kind: "accepted", mode: "live", result: "created", importId: 342 })

    const log = (await liveSnap(w))!
    expect(log).toMatchObject({
      status: "staged",
      row_count: 1,
      // 2 × 10.00 less 10% commission.
      totals: { GBP: "18.00" },
      import_id: 342,
      last_http_status: 202,
      error_code: null,
      attempts: 1,
      pushed_order_ids: [w.orderId],
      pushed_refund_ids: [],
      reported_money_only_refund_ids: [],
      content_hash: payloadHash(body),
      payload_sha256: "a".repeat(64),
    })
    expect(log.generated_at.toISOString()).toBe(body.generated_at)
    expect(log.refund_cutoff_at.toISOString()).toBe("2026-09-14T23:00:00.000Z")
    expect(log.pushed_at).not.toBeNull()

    // What was sent is what the sale is now recorded as.
    const contexts = await w.store.saleContexts(CONN, [w.orderId])
    expect(contexts.get(w.orderId)).toMatchObject({ frozen: false })

    const [attempt] = attempts(w)
    expect(attempt).toMatchObject({
      connection_id: CONN,
      mode: "live",
      trigger: "scheduled",
      state: "accepted",
      http_status: 202,
      result: "created",
      import_id: 342,
      problem_code: null,
      content_hash: log.content_hash,
      body_sha256: sha256(rhq.sent[1]!.body!),
    })
    expect(attempt!.finished_at).not.toBeNull()
    expect(w.notices.map((n) => n.attemptId)).toEqual([attempt!.id])
  })

  it("records the prepared attempt, with its body hash and manifest, before anything is sent", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    let atSend: unknown = null
    const fetch = w.deps.rhq!.fetch!
    w.deps.rhq = {
      ...w.deps.rhq,
      fetch: async (url, init) => {
        if (init.method === "PUT") atSend = structuredClone(w.store.data.attempts)
        return fetch(url, init)
      },
    }
    await pushPeriod(w.deps, "2026-08", live)
    const sent = puts(rhq)[0]!.body!
    expect(atSend).toEqual([
      expect.objectContaining({
        state: "sent",
        finished_at: null,
        body_sha256: sha256(sent),
        manifest: expect.objectContaining({ pushed_order_ids: [w.orderId], refund_cutoff_at: "2026-09-15T00:00:00+01:00" }),
      }),
    ])
  })

  it("refuses a live push while sending is switched off, records why, and notifies nobody", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq, settings: { enabled: false } })
    const outcome = await pushPeriod(w.deps, "2026-08", manual)
    expect(outcome).toMatchObject({ kind: "refused", problem: { code: "disabled" } })
    expect(rhq.sent).toEqual([])
    expect(attempts(w)).toEqual([expect.objectContaining({ mode: "live", trigger: "manual", state: "refused", problem_code: "disabled" })])
    expect(w.notices).toEqual([])
    expect(w.store.data.snapshots).toEqual([])
  })

  it("re-reads the enable switch right before sending, so switching off mid-push sends nothing", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    const load = w.deps.loadPeriodInputs
    // Someone switches sending off while the month is being built.
    w.deps.loadPeriodInputs = async (args) => {
      w.store.saveSettings(settingsFor({ enabled: false }))
      return load(args)
    }
    const outcome = await pushPeriod(w.deps, "2026-08", manual)
    expect(outcome).toMatchObject({ kind: "refused", problem: { code: "disabled" } })
    expect(puts(rhq)).toEqual([])
    expect(attempts(w)).toEqual([expect.objectContaining({ state: "refused", problem_code: "disabled", finished_at: expect.any(Date) })])
    expect(w.notices).toEqual([])
    expect(w.store.data.snapshots).toEqual([])
  })

  it("re-reads the push mode under the lock, so a switch to manual mid-push stops a scheduled one", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    const load = w.deps.loadPeriodInputs
    w.deps.loadPeriodInputs = async (args) => {
      w.store.saveSettings(settingsFor({ push_mode: "manual" }))
      return load(args)
    }
    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "manual_mode" })
    expect(puts(rhq)).toEqual([])
  })

  it("never marks a test-mode push pushed, records no sale context and notifies nobody", async () => {
    const rhq = rhqStub({
      tokenMode: "test",
      writes: [{ status: 202, body: { data: snapshotData({ result: "created", import_id: null }), mode: "test" } }],
    })
    const w = pushWorld({ rhq, token: TEST_TOKEN })
    const outcome = await pushPeriod(w.deps, "2026-08", manual)
    expect(outcome).toMatchObject({ kind: "accepted", mode: "test" })
    expect(attempts(w)[0]).toMatchObject({ mode: "test", result: "created" })
    expect(await liveSnap(w)).toBeNull()
    const testLog = await w.store.findSnapshot({ connectionId: CONN, period: "2026-08", mode: "test" })
    expect(testLog).toMatchObject({ status: "built", pushed_at: null })
    expect((await w.store.saleContexts(CONN, [w.orderId])).size).toBe(0)
    expect(w.notices).toEqual([])
  })

  it("never marks pushed when only the answer says test mode", async () => {
    // A live-looking token, but RHQ's write answer carries the test marker.
    const rhq = rhqStub({
      writes: [{ status: 202, body: { data: snapshotData({ result: "created", import_id: null }), mode: "test" } }],
    })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "accepted", mode: "test" })
    expect(await liveSnap(w)).toBeNull()
    expect((await w.store.saleContexts(CONN, [w.orderId])).size).toBe(0)
  })

  it("skips a scheduled test-mode push whose content matches the last test-mode attempt", async () => {
    const testAnswer = { status: 202, body: { data: snapshotData({ result: "created", import_id: null }), mode: "test" } }
    const rhq = rhqStub({ tokenMode: "test", writes: [testAnswer, testAnswer] })
    const w = pushWorld({ rhq, token: TEST_TOKEN })
    await pushPeriod(w.deps, "2026-08", live)
    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "unchanged" })
    expect(puts(rhq)).toHaveLength(1)
    // Push now still sends: that is how a person asks again.
    await pushPeriod(w.deps, "2026-08", manual)
    expect(puts(rhq)).toHaveLength(2)
  })

  it("re-sends unchanged content with its first generated_at, and skips a scheduled re-push of a staged month outright", async () => {
    const rhq = rhqStub({ writes: [accepted("created"), accepted("unchanged")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    const first = rhq.sent[1]!
    rhq.state.periods = [{ period: "2026-08", status: "staged", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342 }]

    w.setNow("2026-09-21T03:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "unchanged" })
    expect(puts(rhq)).toHaveLength(1)

    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "accepted", result: "unchanged" })
    // Byte for byte, so RHQ can answer "unchanged".
    expect(puts(rhq)[1]!.body).toBe(first.body)
    expect(attempts(w)).toHaveLength(2)
  })

  it("sends changed content as a new version, keeping the cut-off RHQ recorded, and loads the month up to it", async () => {
    const rhq = rhqStub({ writes: [accepted("created"), accepted("replaced")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    const firstBody = bodyOf(rhq.sent[1]!)
    rhq.state.periods = [{ period: "2026-08", status: "staged", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342 }]

    // The owner moves the push day, and a refund of one copy arrives: the
    // cut-off must stay the one August was first sent with.
    w.store.saveSettings(settingsFor({ push_day: 20 }))
    w.ledger.refund(w.orderId, { createdAt: "2026-09-10T10:00:00Z", amount: 1000n })
    w.setNow("2026-09-21T03:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted", result: "replaced" })
    const secondBody = bodyOf(puts(rhq)[1]!)
    expect(secondBody.settings.refund_cutoff_at).toBe(firstBody.settings.refund_cutoff_at)
    expect(secondBody.generated_at).not.toBe(firstBody.generated_at)
    // The loader is asked for refunds up to the same cut-off the core uses.
    expect(w.loads.map((l) => l.refundCutoffAt)).toEqual(["2026-09-15T00:00:00+01:00", "2026-09-15T00:00:00+01:00"])
    const log = (await liveSnap(w))!
    expect(log.attempts).toBe(2)
    expect(log.pushed_refund_ids).toHaveLength(1)
  })

  it("syncs an imported month from the handshake: freezes its sales and never sends it again", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    rhq.state.periods = [{ period: "2026-08", status: "imported", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342 }]

    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "imported" })
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "refused", problem: { code: "period_imported" } })
    expect(puts(rhq)).toHaveLength(1)
    expect((await liveSnap(w))!.status).toBe("imported")
    expect(w.store.data.saleContexts).toEqual([expect.objectContaining({ order_id: w.orderId, frozen_reason: "period_imported" })])
  })

  it("records and freezes a late sale's context against the month that carried it", async () => {
    const julyImported = { period: "2026-07", status: "imported" as const, refund_cutoff_at: "2026-08-14T23:00:00Z", import_id: 311 }
    const rhq = rhqStub({ periods: [julyImported], writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    // July went out (and was imported) without L, which was stored late.
    await w.store.upsertSnapshot(
      { connectionId: CONN, period: "2026-07", mode: "live" },
      {
        status: "imported",
        refund_cutoff_at: new Date("2026-08-14T23:00:00Z"),
        content_hash: "0".repeat(64),
        generated_at: new Date("2026-08-15T02:00:00Z"),
        row_count: 0,
        totals: {},
        pushed_at: new Date("2026-08-15T02:00:00Z"),
        pushed_order_ids: ["order_other"],
        pushed_refund_ids: [],
      },
      { countAttempt: true },
    )
    const late = w.ledger.order({ paidAt: "2026-07-28T10:00:00Z", lines: [{ variant: 1, price: 500n }] })

    await pushPeriod(w.deps, "2026-08", live)
    expect((await liveSnap(w))!.pushed_order_ids).toEqual([w.orderId, late.id].sort())
    // What August sent for L is what L is now recorded as.
    expect((await w.store.saleContexts(CONN, [late.id])).get(late.id)).toMatchObject({ frozen: false })

    // August is imported: L's context is now RHQ's for good.
    rhq.state.periods = [julyImported, { period: "2026-08", status: "imported", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342 }]
    await pushPeriod(w.deps, "2026-08", live)
    expect(w.store.data.saleContexts.find((c) => c.order_id === late.id)).toMatchObject({ frozen_reason: "period_imported" })
  })

  it("takes cut-offs and 'already pushed' only from locally accepted pushes, not RHQ's rejected months", async () => {
    // RHQ kept a rejected snapshot of August (from a push that never got an
    // acceptance here) with its own cut-off.
    const rhq = rhqStub({
      periods: [{ period: "2026-08", status: "rejected", refund_cutoff_at: "2026-09-09T23:00:00Z", import_id: null }],
      writes: [accepted("created")],
    })
    const w = pushWorld({ rhq })
    // Money only, not a whole number of copies, before the scheduled cut-off.
    w.ledger.refund(w.orderId, { createdAt: "2026-09-01T10:00:00Z", amount: 200n })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted", ignoredMoneyOnlyRefunds: 0 })
    // The schedule's cut-off: August was never accepted here.
    expect(bodyOf(rhq.sent[1]!).settings.refund_cutoff_at).toBe("2026-09-15T00:00:00+01:00")
    // Applied to the sale: August had not gone out.
    expect((await liveSnap(w))!.applied_money_only_refund_ids).toHaveLength(1)
  })

  it("re-pushes a staged month whose import was deleted in RHQ, and forgets the import id", async () => {
    const rhq = rhqStub({ writes: [accepted("created"), { status: 500, body: PROBLEMS.serverError() }, accepted("created", { import_id: 400 })] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    // The publisher deleted the staged import: RHQ keeps the snapshot as
    // staged with no import, and rebuilds one on the next push.
    rhq.state.periods = [{ period: "2026-08", status: "staged", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: null }]
    w.setNow("2026-09-21T03:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "problem" })
    expect(puts(rhq)).toHaveLength(2)
    expect(await liveSnap(w)).toMatchObject({ import_id: null, status: "staged" })

    w.setNow("2026-09-22T03:00:00.000Z")
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted", importId: 400 })
  })

  it("stores ignored money-only refunds on the attempt", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    // A refund of an order the reader never saw sold: it cannot lower a
    // sale, so it is reported instead.
    w.ledger.orphanRefunds.push({
      orderId: "order_999",
      currency: "GBP",
      refund: { id: "ref_orphan", createdAt: "2026-08-20T10:00:00Z", lines: [], shipping: { amount: 0n, tax: 0n }, unallocatedAmount: 150n },
    })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted", ignoredMoneyOnlyRefunds: 1 })
    expect(attempts(w)[0]!.warnings).toEqual([expect.objectContaining({ orderId: "order_999", currency: "GBP", amount: "1.50" })])
    expect((await liveSnap(w))!.reported_money_only_refund_ids).toHaveLength(1)
  })

  it("leaves a month that went out unchanged by a later money-only refund, which is reported in its own month", async () => {
    const rhq = rhqStub({
      writes: [accepted("created"), accepted("unchanged"), accepted("created", { period: "2026-09" }), accepted("unchanged", { period: "2026-09" })],
    })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", manual)
    // Money only, not a whole number of copies, made after August went out:
    // too late to lower the sale, so it is reported rather than applied.
    w.setNow("2026-09-21T03:00:00.000Z")
    const late = w.ledger.refund(w.orderId, { createdAt: "2026-09-20T15:00:00Z", amount: 250n })
    await pushPeriod(w.deps, "2026-08", manual)
    expect(puts(rhq)[1]!.body).toBe(puts(rhq)[0]!.body)
    expect(await liveSnap(w)).toMatchObject({ applied_money_only_refund_ids: [], reported_money_only_refund_ids: [] })

    w.setNow("2026-10-20T03:00:00.000Z")
    await pushPeriod(w.deps, "2026-09", manual)
    expect((await liveSnap(w, "2026-09"))!.reported_money_only_refund_ids).toEqual([late.id])
    w.setNow("2026-10-21T03:00:00.000Z")
    await pushPeriod(w.deps, "2026-09", manual)
    expect(puts(rhq)).toHaveLength(4)
    expect(puts(rhq)[3]!.body).toBe(puts(rhq)[2]!.body)
  })

  it("refuses a month over the row limit before sending anything", async () => {
    // An install from before api.limits: the 3,100-row cap every RHQ
    // release enforced is assumed.
    const older = connectionBody({ periods: [] })
    const data = older.data as Record<string, unknown>
    delete data.api
    delete data.store
    delete data.auto_import
    const rhq = rhqStub({ handshake: { status: 200, raw: true, body: older } })
    const w = pushWorld({ rhq })
    const variants = Array.from({ length: 3101 }, (_, i) => 1000 + i)
    for (const n of variants) w.ledger.product(n, { sku: `SKU-${n}` })
    w.ledger.order({ paidAt: "2026-08-12T10:00:00Z", lines: variants.map((n) => ({ variant: n, price: 100n })) })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "problem", problem: { code: "too_many_rows" }, retryAt: null })
    expect(puts(rhq)).toEqual([])
    const [attempt] = attempts(w)
    expect(attempt!.problem_detail).toContain("3102")
    expect(w.notices.map((n) => n.attemptId)).toEqual([attempt!.id])
  }, 60_000)

  it("reports 'busy' when another push holds the lock, and sends nothing", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq })
    w.lock.held.add(PUSH_LOCK_KEY)
    expect(await pushPeriod(w.deps, "2026-08", manual)).toEqual({ kind: "busy" })
    expect(rhq.sent).toEqual([])
    expect(attempts(w)).toEqual([])
  })

  it("takes the store's one push lock without waiting for it", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(w.lock.calls).toEqual([{ key: "royalties-hq:push", args: { timeout: 1, expire: 120 } }])
  })

  it("lets one of two concurrent pushers send; the other is told someone is pushing", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    const outcomes = await Promise.all([pushPeriod(w.deps, "2026-08", manual), pushPeriod(w.deps, "2026-08", manual)])
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["accepted", "busy"])
    expect(puts(rhq)).toHaveLength(1)
  })

  it("passes on a failure of the push itself rather than calling it busy", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    w.store.failNext("recordAcceptance", new Error("database went away"))
    await expect(pushPeriod(w.deps, "2026-08", manual)).rejects.toThrow("database went away")
  })
})

describe("pushPeriod: problems", () => {
  it("schedules a scheduled push's retry when RHQ asks, honouring Retry-After", async () => {
    const rhq = rhqStub({ writes: [{ status: 503, body: PROBLEMS.unavailable(), headers: { "Retry-After": "120" } }] })
    const w = pushWorld({ rhq })
    const outcome = await pushPeriod(w.deps, "2026-08", live)
    expect(outcome).toMatchObject({ kind: "problem", problem: { code: "service_unavailable" }, scope: "connection", stop: false })
    expect(outcome.kind === "problem" && outcome.retryAt?.toISOString()).toBe("2026-09-20T12:02:00.000Z")
    const [attempt] = attempts(w)
    expect(attempt).toMatchObject({ state: "failed", http_status: 503, problem_code: "service_unavailable", retry_count: 1 })
    expect(attempt!.retry_at?.toISOString()).toBe("2026-09-20T12:02:00.000Z")
    // Every live attempt is reported, problems included.
    expect(w.notices.map((n) => n.attemptId)).toEqual([attempt!.id])
    expect(await liveSnap(w)).toMatchObject({ status: "failed", pushed_at: null, error_code: "service_unavailable" })
  })

  it("honours a 429's Retry-After too", async () => {
    const rhq = rhqStub({ writes: [{ status: 429, body: PROBLEMS.rateLimited(), headers: { "Retry-After": "30" } }] })
    const w = pushWorld({ rhq })
    const outcome = await pushPeriod(w.deps, "2026-08", live)
    expect(outcome.kind === "problem" && outcome.retryAt?.toISOString()).toBe("2026-09-20T12:00:30.000Z")
  })

  it("backs off on other transient failures, counting the attempts of one logical push", async () => {
    const rhq = rhqStub({ writes: [{ status: 500, body: PROBLEMS.serverError() }] })
    const w = pushWorld({ rhq })
    const outcome = await pushPeriod(w.deps, "2026-08", { ...live, retry: { firstAttemptAt: new Date("2026-09-20T11:00:00.000Z"), attempts: 2 } })
    // Third attempt: full jitter over 30 s × 2², with random() = 0.5.
    expect(outcome.kind === "problem" && outcome.retryAt?.toISOString()).toBe("2026-09-20T12:01:00.000Z")
    expect(outcome).toMatchObject({ retry: { attempts: 3 } })
    expect(attempts(w)[0]).toMatchObject({ retry_count: 3 })
  })

  it("gives up after 24 hours", async () => {
    const rhq = rhqStub({ writes: [{ status: 500, body: PROBLEMS.serverError() }] })
    const w = pushWorld({ rhq })
    const outcome = await pushPeriod(w.deps, "2026-08", { ...live, retry: { firstAttemptAt: new Date("2026-09-19T11:00:00.000Z"), attempts: 9 } })
    expect(outcome).toMatchObject({ kind: "problem", retryAt: null })
    expect(attempts(w)[0]).toMatchObject({ state: "failed", retry_at: null })
  })

  it("never retries period_committed, and stops the run for a person", async () => {
    const rhq = rhqStub({ writes: [{ status: 409, body: PROBLEMS.periodCommitted() }] })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({
      kind: "problem",
      retryAt: null,
      stop: true,
      problem: { code: "period_committed" },
    })
    const [attempt] = attempts(w)
    expect(attempt).toMatchObject({ state: "rejected", import_id: 342, http_status: 409 })
    expect(w.notices.map((n) => n.attemptId)).toEqual([attempt!.id])
  })

  it("records row errors, and does not re-send the same rejected content on schedule", async () => {
    const rhq = rhqStub({ writes: [{ status: 422, body: PROBLEMS.validationFailed() }] })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "problem", stop: false })
    expect(attempts(w)[0]).toMatchObject({ row_errors: PROBLEMS.validationFailed().errors, state: "rejected" })
    expect(await liveSnap(w)).toMatchObject({ status: "rejected", pushed_at: null })

    // RHQ keeps a rejected snapshot and lists it in the handshake.
    rhq.state.periods = [{ period: "2026-08", status: "rejected", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342 }]
    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "already_rejected" })
    expect(puts(rhq)).toHaveLength(1)
  })

  it.each([
    ["rows.0.royalty_on_sales", "The royalty must be a decimal string."],
    ["rows.2.units_sold", "Units sold must be a whole number."],
    ["rows.1.list_price", "The list price must be a decimal string."],
  ])("stops the run on a 422 about a money or unit field (%s): the builder is wrong, not the data", async (key, message) => {
    const body = { ...PROBLEMS.validationFailed(), errors: { [key]: [message] } }
    const rhq = rhqStub({ writes: [{ status: 422, body }] })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "problem", stop: true, retryAt: null })
  })

  it("keeps an accepted month staged, with its manifests, when a later re-push is refused", async () => {
    const rhq = rhqStub({ writes: [accepted("created"), { status: 422, body: PROBLEMS.validationFailed() }] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    const before = (await liveSnap(w))!
    w.ledger.refund(w.orderId, { createdAt: "2026-09-10T10:00:00Z", amount: 1000n })
    await pushPeriod(w.deps, "2026-08", manual)
    expect(await liveSnap(w)).toMatchObject({
      status: "staged",
      content_hash: before.content_hash,
      pushed_refund_ids: [],
      pushed_at: before.pushed_at,
      error_code: "validation_failed",
      last_http_status: 422,
      attempts: 2,
    })
  })

  it("does not schedule retries for Push now", async () => {
    const rhq = rhqStub({ writes: [{ status: 500, body: PROBLEMS.serverError() }] })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "problem", retryAt: null })
    const [attempt] = attempts(w)
    expect(attempt).toMatchObject({ state: "failed", retry_at: null })
    expect(w.notices.map((n) => n.attemptId)).toEqual([attempt!.id])
  })

  it("records a failed handshake as the attempt's problem", async () => {
    const rhq = rhqStub({ handshake: { status: 401, body: PROBLEMS.unauthenticated() } })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({
      kind: "problem",
      scope: "connection",
      retryAt: null,
      problem: { code: "unauthenticated" },
    })
    const [attempt] = attempts(w)
    // A connection problem, not a verdict on the month's content.
    expect(attempt).toMatchObject({ http_status: 401, problem_code: "unauthenticated", state: "failed", content_hash: null, connection_id: null })
    expect(w.notices.map((n) => n.attemptId)).toEqual([attempt!.id])
  })

  it("records a build that failed, logging it without the order data", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq })
    w.deps.loadPeriodInputs = async () => {
      throw new Error("query.graph: connection refused")
    }
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "problem", problem: { code: "build_failed" } })
    expect(puts(rhq)).toEqual([])
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "push.build_failed", period: "2026-08", error: "Error: query.graph: connection refused" }))
  })
})

describe("pushPeriod: rejected means content, failed means connection", () => {
  const rejectedInRhq = { period: "2026-08", status: "rejected" as const, refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: null }

  it("records an auth failure on the write as failed, and sends the same content again next time", async () => {
    const rhq = rhqStub({ writes: [{ status: 401, body: PROBLEMS.unauthenticated() }, accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(attempts(w)[0]).toMatchObject({ state: "failed", problem_code: "unauthenticated" })
    expect(await liveSnap(w)).toMatchObject({ status: "failed" })
    // The token was fixed: the same month, same bytes, must go out.
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted", result: "created" })
    expect(puts(rhq)).toHaveLength(2)
  })

  it("records period_not_ended as failed, not a rejection of the data", async () => {
    const rhq = rhqStub({ writes: [{ status: 422, body: PROBLEMS.periodNotEnded() }] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(attempts(w)[0]!.state).toBe("failed")
    expect((await liveSnap(w))!.status).toBe("failed")
  })

  it("re-sends rejected content once RHQ no longer reports the month rejected", async () => {
    const rhq = rhqStub({ periods: [], writes: [{ status: 422, body: PROBLEMS.validationFailed() }, accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(attempts(w)[0]!.state).toBe("rejected")
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted" })
  })

  it("skips duplicate_period content while RHQ still reports the month rejected", async () => {
    const rhq = rhqStub({ periods: [rejectedInRhq], writes: [{ status: 422, body: PROBLEMS.duplicatePeriod() }] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(attempts(w)[0]!.state).toBe("rejected")
    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "already_rejected" })
  })

  it("does not skip after a connection failure even when RHQ lists the month rejected from an older push", async () => {
    const rhq = rhqStub({ periods: [rejectedInRhq], writes: [{ status: 403, body: PROBLEMS.forbidden() }, accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted" })
  })

  it("does not rebuild and re-refuse an over-size month with the same content every day", async () => {
    const rhq = rhqStub({ writes: [{ status: 413, body: PROBLEMS.payloadTooLarge() }] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    expect(attempts(w)[0]!.state).toBe("rejected")
    // RHQ keeps nothing for a 413, so the handshake cannot say "rejected";
    // the same bytes are refused the same way, so they are not sent again.
    expect(await pushPeriod(w.deps, "2026-08", live)).toEqual({ kind: "skipped", reason: "already_rejected" })
  })
})

describe("pushPeriod: a 2xx RHQ answered with a body this plugin cannot read", () => {
  const garbled = { status: 202, body: "<html>proxy says ok</html>", raw: true }

  it("confirms by reading the month back, and records the push as accepted when RHQ holds it", async () => {
    // An install that sends no payload_sha256: matched on when RHQ received
    // it, its cut-off and row count. With a hash, the hash decides.
    const readBack = snapshotData({ received_at: "2026-09-20T12:00:00Z", counts: { rows: 1, errors: 0, warnings: 0 } })
    delete readBack.payload_sha256
    const rhq = rhqStub({ writes: [garbled, { status: 200, raw: true, body: { data: readBack } }] })
    const w = pushWorld({ rhq })
    const outcome = await pushPeriod(w.deps, "2026-08", live)
    expect(paths(rhq)).toEqual(["GET /api/v1/connection", "PUT /api/v1/sales-snapshots/2026-08", "GET /api/v1/sales-snapshots/2026-08"])
    expect(outcome).toMatchObject({ kind: "accepted", mode: "live" })
    expect(await liveSnap(w)).toMatchObject({ pushed_at: expect.any(Date), pushed_order_ids: [w.orderId] })
    expect(attempts(w)[0]).toMatchObject({ state: "accepted", result: "confirmed", problem_code: null })
  })

  it("records unknown, marks nothing pushed and settles it on the next push", async () => {
    const olderCopy = { status: 200, body: { data: snapshotData({ received_at: "2026-09-01T00:00:00Z" }) } }
    const rhq = rhqStub({
      writes: [
        garbled,
        // An older version: received before this attempt started.
        olderCopy,
        // The next push reads the month back first, still finds the old copy…
        olderCopy,
        // …and sends the same bytes again; RHQ's "unchanged" settles it.
        accepted("unchanged"),
      ],
    })
    const w = pushWorld({ rhq })
    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "problem", problem: { code: "unexpected_response" } })
    expect(attempts(w)[0]!.state).toBe("unknown")
    expect(await liveSnap(w)).toMatchObject({ pushed_at: null, status: "failed" })
    expect((await w.store.saleContexts(CONN, [w.orderId])).size).toBe(0)

    expect(await pushPeriod(w.deps, "2026-08", live)).toMatchObject({ kind: "accepted", result: "unchanged" })
    expect(puts(rhq)[1]!.body).toBe(puts(rhq)[0]!.body)
  })
})

describe("pushPeriod: validate", () => {
  it("dry-runs while sending is off, stores nothing but the attempt and notifies nobody", async () => {
    const rhq = rhqStub({ writes: [{ status: 202, body: { data: snapshotData({ result: "created", import_id: null }), dry_run: true } }] })
    const w = pushWorld({ rhq, settings: { enabled: false } })
    expect(await pushPeriod(w.deps, "2026-08", validate)).toMatchObject({ kind: "accepted", mode: "dry_run" })
    expect(new URL(rhq.sent[1]!.url).pathname).toBe("/api/v1/sales-snapshots/2026-08/validate")
    expect(JSON.parse(rhq.sent[1]!.body!)).toMatchObject({ rows: [expect.objectContaining({ identifiers: expect.objectContaining({ isbn: ISBN }) })] })
    expect(w.store.data.snapshots).toEqual([])
    expect(attempts(w)).toEqual([expect.objectContaining({ mode: "dry_run", state: "accepted" })])
    expect(w.store.data.saleContexts).toEqual([])
    expect(w.notices).toEqual([])
    // A dry run reaches nothing RHQ keeps, so it does not wait for a live push.
    expect(w.lock.calls).toEqual([])
  })

  it("refuses to validate without a connection", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq, settings: { base_url: null } })
    expect(await pushPeriod(w.deps, "2026-08", validate)).toMatchObject({ kind: "refused", problem: { code: "not_connected" } })
    expect(rhq.sent).toEqual([])
  })

  it("refuses without a token, and when the saved one cannot be read", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq })
    w.deps.token = async () => null
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "refused", problem: { code: "not_connected" } })
    w.deps.token = async () => {
      throw new Error("bad seal")
    }
    expect(await pushPeriod(w.deps, "2026-08", manual)).toMatchObject({ kind: "refused", problem: { code: "token_unreadable" } })
    expect(rhq.sent).toEqual([])
  })
})

describe("canonical bytes", () => {
  it("sends exactly the canonical JSON of what it hashed", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", live)
    const sent = rhq.sent[1]!.body!
    expect(canonicalJson(JSON.parse(sent))).toBe(sent)
    expect(attempts(w)[0]!.content_hash).toBe(payloadHash(JSON.parse(sent)))
  })
})

describe("markInterruptedAttempts", () => {
  it("closes attempts a dead process left open for over 15 minutes, and nothing else", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq })
    const now = new Date("2026-09-20T12:00:00.000Z")
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000)
    const base = { connection_id: CONN, period: "2026-08", mode: "live" as const, trigger: "scheduled" as const }
    const stale = await w.store.createAttempt({ ...base, state: "sent", started_at: minutesAgo(20) })
    const prepared = await w.store.createAttempt({ ...base, state: "prepared", started_at: minutesAgo(20) })
    const running = await w.store.createAttempt({ ...base, state: "sent", started_at: minutesAgo(5) })
    const done = await w.store.createAttempt({ ...base, state: "accepted", started_at: minutesAgo(60), finished_at: minutesAgo(59), result: "created" })

    expect(await markInterruptedAttempts(w.store, now)).toBe(2)
    const read = (id: string) => w.store.data.attempts.find((a) => a.id === id)
    expect(read(stale.id)).toMatchObject({ state: "interrupted", finished_at: now })
    expect(read(prepared.id)).toMatchObject({ state: "interrupted", finished_at: now })
    expect(read(running.id)).toMatchObject({ state: "sent", finished_at: null })
    expect(read(done.id)).toMatchObject({ state: "accepted", result: "created" })
  })
})


describe("pushPeriod: refunds on orders that are no sale", () => {
  it("carries the loader's count into the summary RHQ receives", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    const load = w.deps.loadPeriodInputs
    w.deps.loadPeriodInputs = async (args) => ({ ...(await load(args)), refundsOnUnpaidOrders: 1 })
    await pushPeriod(w.deps, "2026-08", live)
    expect(JSON.parse(puts(rhq)[0]!.body!).summary.refunds_on_unpaid_orders).toBe(1)
  })
})

describe("pushPeriod: the connection record after a token change", () => {
  // The token route marks the connection unconfirmed. A push that started
  // before the change handshook with the old token, so it must not write the
  // old connection back over the mark.
  it("does not record its connection over a token change made after it started", async () => {
    const w = pushWorld({ rhq: rhqStub({ writes: [accepted("created")] }) })
    const mark = { unconfirmed_since: "2026-09-20T12:00:01.000Z" }
    await w.store.writeState("connection", mark)
    await pushPeriod(w.deps, "2026-08", { mode: "live", trigger: "manual" })
    expect(await w.store.readState("connection")).toEqual(mark)
  })

  it("does not record it over a token change made while it read the token", async () => {
    const w = pushWorld({ rhq: rhqStub({ writes: [accepted("created")] }) })
    await w.store.writeState("connection", { id: 7, marketplace: "Acme Shop" })
    const token = w.deps.token
    // The change lands as the push reads the old token, before it begins.
    w.deps.token = async () => {
      await w.store.writeState("connection", { unconfirmed_since: "2026-09-20T12:00:00.000Z" })
      return token()
    }
    await pushPeriod(w.deps, "2026-08", { mode: "live", trigger: "manual" })
    expect(await w.store.readState("connection")).toEqual({ unconfirmed_since: "2026-09-20T12:00:00.000Z" })
  })

  it("records it when the token changed before it started", async () => {
    const w = pushWorld({ rhq: rhqStub({ writes: [accepted("created")] }) })
    await w.store.writeState("connection", { unconfirmed_since: "2026-09-20T11:00:00.000Z" })
    await pushPeriod(w.deps, "2026-08", { mode: "live", trigger: "manual" })
    expect(await w.store.readState("connection")).toEqual({ id: 7, marketplace: "Acme Shop" })
  })
})
