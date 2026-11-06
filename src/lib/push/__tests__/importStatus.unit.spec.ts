import { PROBLEMS, snapshotData, TEST_TOKEN, type Reply } from "../../rhq/__tests__/support/fakeRhq"
import { createSnapshotActions } from "../actions"
import { checkStagedImports, MANUAL_CHECK_INTERVAL_MS } from "../importStatus"
import { pushPeriod } from "../push"
import type { SnapshotPatch } from "../store"
import { accepted, pushWorld, rhqStub, settingsFor, type PushWorld, type RhqPeriods, type RhqStub } from "./support/world"

// RHQ's own view of each staged month's import: read with GET
// /sales-snapshots/{period} (from the scheduler, or on demand from the status
// page) and kept on the month's live snapshot, so the status page can warn
// that an import failed in RHQ, which no push from here can fix.

const CONN = 7
const FAILED_MESSAGE = "Unexpected error while importing: the import could not be saved"

const failedImport = (overrides: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: { data: snapshotData({ counts: { rows: 2, errors: 1, warnings: 0 }, errors: { rows: [FAILED_MESSAGE] }, ...overrides }) },
})

const periods = (overrides: Partial<RhqPeriods[number]> = {}): RhqPeriods => [
  // Deleted in RHQ: nothing to ask about.
  { period: "2026-06", status: "staged", refund_cutoff_at: "2026-07-15T00:00:00Z", import_id: null },
  { period: "2026-07", status: "imported", refund_cutoff_at: "2026-08-15T00:00:00Z", import_id: 311 },
  { period: "2026-08", status: "staged", refund_cutoff_at: "2026-09-14T23:00:00Z", import_id: 342, ...overrides },
]

async function stagedLog(w: PushWorld, period: string, data: SnapshotPatch = {}) {
  return w.store.upsertSnapshot(
    { connectionId: CONN, period, mode: "live" },
    {
      status: "staged",
      refund_cutoff_at: new Date("2026-09-14T23:00:00Z"),
      content_hash: "a".repeat(64),
      generated_at: new Date("2026-09-15T02:00:00Z"),
      row_count: 2,
      totals: {},
      import_id: 342,
      pushed_at: new Date("2026-09-15T02:13:08Z"),
      pushed_order_ids: [],
      ...data,
    },
    { countAttempt: true },
  )
}

const logOf = async (w: PushWorld, period = "2026-08") => (await w.store.findSnapshot({ connectionId: CONN, period, mode: "live" }))!
const gets = (rhq: RhqStub) => rhq.sent.filter((r) => r.method === "GET" && r.url.includes("/sales-snapshots/")).map((r) => new URL(r.url).pathname.split("/").pop())
const scheduled = { trigger: "scheduled" } as const

describe("checkStagedImports", () => {
  it("asks RHQ once about each staged month that has an import, and records its errors", async () => {
    const rhq = rhqStub({ periods: periods(), writes: [failedImport()] })
    const w = pushWorld({ rhq })
    await stagedLog(w, "2026-06", { import_id: null })
    await stagedLog(w, "2026-08")

    expect(await checkStagedImports(w.deps, scheduled)).toEqual({ kind: "checked", periods: ["2026-08"], failed: null })
    expect(gets(rhq)).toEqual(["2026-08"])
    expect(await logOf(w)).toMatchObject({
      status: "staged",
      import_id: 342,
      rhq_error_count: 1,
      rhq_error_summary: FAILED_MESSAGE,
      rhq_error_reason: null,
      rhq_checked_at: new Date("2026-09-20T12:00:00.000Z"),
    })
  })

  it("records the reason code RHQ sends", async () => {
    const rhq = rhqStub({
      periods: periods(),
      writes: [
        {
          ...failedImport({ errors: { rows: [{ row: null, reason: "import_failed", message: "The import could not be completed in Royalties HQ. Retry or delete it there." }] } }),
          raw: true,
        },
      ],
    })
    const w = pushWorld({ rhq })
    await stagedLog(w, "2026-08")
    await checkStagedImports(w.deps, scheduled)
    expect(await logOf(w)).toMatchObject({
      rhq_error_count: 1,
      rhq_error_reason: "import_failed",
      rhq_error_summary: "The import could not be completed in Royalties HQ. Retry or delete it there.",
    })
  })

  it("stores a short, sanitised line, never RHQ's whole text", async () => {
    const rhq = rhqStub({ periods: periods(), writes: [failedImport({ errors: { rows: [`Unexpected error while importing:\n<b>SQLSTATE</b>\u0000 ${"x".repeat(400)}`] } })] })
    const w = pushWorld({ rhq })
    await stagedLog(w, "2026-08")
    await checkStagedImports(w.deps, scheduled)
    const log = await logOf(w)
    expect(log.rhq_error_summary).toHaveLength(300)
    expect(log.rhq_error_summary).toMatch(/^Unexpected error while importing: <b>SQLSTATE<\/b> x+…$/)
  })

  it("records a clean month as checked with no errors", async () => {
    const rhq = rhqStub({ periods: periods(), writes: [{ status: 200, body: { data: snapshotData() } }] })
    const w = pushWorld({ rhq })
    await stagedLog(w, "2026-08", { rhq_error_count: 1, rhq_error_summary: FAILED_MESSAGE })
    await checkStagedImports(w.deps, scheduled)
    expect(await logOf(w)).toMatchObject({ rhq_error_count: 0, rhq_error_summary: null, rhq_error_reason: null, rhq_checked_at: new Date("2026-09-20T12:00:00.000Z") })
  })

  it("refreshes the hold-back reasons and the import link from the GET", async () => {
    // A person may resolve a hold-back in RHQ without importing, and the
    // reasons only arrive on a snapshot answer, never the handshake.
    const rhq = rhqStub({ periods: periods(), writes: [{ status: 200, body: { data: snapshotData({ hold_back_reasons: ["anomaly"] }) } }] })
    const w = pushWorld({ rhq })
    await stagedLog(w, "2026-08")
    await checkStagedImports(w.deps, scheduled)
    expect(await logOf(w)).toMatchObject({ hold_back_reasons: ["anomaly"], import_url: "https://acme.royaltieshq.com/imports/342" })
  })

  it("keeps what it knew when the GET fails, and says so without throwing", async () => {
    const rhq = rhqStub({ periods: periods(), writes: [{ status: 500, body: PROBLEMS.serverError() }] })
    const w = pushWorld({ rhq })
    const checkedAt = new Date("2026-09-19T12:00:00Z")
    await stagedLog(w, "2026-08", { rhq_error_count: 1, rhq_error_summary: FAILED_MESSAGE, rhq_checked_at: checkedAt })
    expect(await checkStagedImports(w.deps, scheduled)).toMatchObject({ kind: "checked", periods: [], failed: { code: "server_error" } })
    expect(await logOf(w)).toMatchObject({ rhq_error_count: 1, rhq_error_summary: FAILED_MESSAGE, rhq_checked_at: checkedAt })
  })

  it("asks nothing with a test-mode token: it has no staged imports", async () => {
    const rhq = rhqStub({ periods: periods(), tokenMode: "test" })
    const w = pushWorld({ rhq, token: TEST_TOKEN })
    await stagedLog(w, "2026-08")
    expect(await checkStagedImports(w.deps, scheduled)).toEqual({ kind: "checked", periods: [], failed: null })
    expect(gets(rhq)).toEqual([])
  })

  it("is refused without a connection", async () => {
    const rhq = rhqStub({ periods: periods() })
    const w = pushWorld({ rhq })
    w.store.saveSettings(settingsFor({ base_url: null }))
    expect(await checkStagedImports(w.deps, { trigger: "manual" })).toMatchObject({ kind: "refused" })
    expect(rhq.sent).toEqual([])
  })

  it("ignores another connection's snapshots", async () => {
    const rhq = rhqStub({ periods: periods() })
    const w = pushWorld({ rhq })
    await w.store.upsertSnapshot(
      { connectionId: 8, period: "2026-08", mode: "live" },
      { status: "staged", refund_cutoff_at: new Date(), content_hash: "a".repeat(64), generated_at: new Date(), row_count: 0, totals: {}, import_id: 342, pushed_at: new Date() },
      { countAttempt: true },
    )
    expect(await checkStagedImports(w.deps, scheduled)).toEqual({ kind: "checked", periods: [], failed: null })
    expect(gets(rhq)).toEqual([])
  })
})

describe("clearing RHQ's view of a month", () => {
  const withErrors = { rhq_error_count: 1, rhq_error_summary: FAILED_MESSAGE, rhq_error_reason: "import_failed", rhq_checked_at: new Date("2026-09-19T12:00:00Z") }
  const cleared = { rhq_error_count: null, rhq_error_summary: null, rhq_error_reason: null, rhq_checked_at: null }

  it.each([
    ["imported", { status: "imported" as const }],
    ["deleted in RHQ", { import_id: null }],
    ["a different import", { import_id: 400 }],
  ] as [string, Partial<RhqPeriods[number]>][])("clears when the handshake shows the month %s", async (_, change) => {
    const rhq = rhqStub({ periods: periods(change), writes: [failedImport({ import_id: 400 })] })
    const w = pushWorld({ rhq })
    await stagedLog(w, "2026-08", withErrors)
    await checkStagedImports(w.deps, scheduled)
    const log = await logOf(w)
    if (change.import_id === 400) {
      // The new import is asked about at once.
      expect(log).toMatchObject({ import_id: 400, rhq_error_count: 1, rhq_checked_at: new Date("2026-09-20T12:00:00.000Z") })
    } else {
      expect(log).toMatchObject(cleared)
    }
  })

  it("clears when a push replaces the import, but not on unchanged", async () => {
    const rhq = rhqStub({ periods: periods(), writes: [accepted("unchanged"), accepted("replaced", { import_id: 343 })] })
    const w = pushWorld({ rhq })
    await stagedLog(w, "2026-08", withErrors)
    await pushPeriod(w.deps, "2026-08", { mode: "live", trigger: "manual" })
    expect(await logOf(w)).toMatchObject(withErrors)
    rhq.state.periods = periods()
    await pushPeriod(w.deps, "2026-08", { mode: "live", trigger: "manual" })
    expect(await logOf(w)).toMatchObject({ import_id: 343, ...cleared })
  })
})

describe("the status page's Check RHQ status", () => {
  it("claims one manual check per interval", async () => {
    const w = pushWorld({ rhq: rhqStub({}) })
    const t0 = new Date("2026-09-20T12:00:00Z")
    expect(await w.store.claimManualCheck(t0, MANUAL_CHECK_INTERVAL_MS)).toBe(true)
    expect(await w.store.claimManualCheck(new Date(t0.getTime() + 30_000), MANUAL_CHECK_INTERVAL_MS)).toBe(false)
    expect(await w.store.claimManualCheck(new Date(t0.getTime() + MANUAL_CHECK_INTERVAL_MS), MANUAL_CHECK_INTERVAL_MS)).toBe(true)
  })

  it("checks at once, then refuses a second press within the minute without asking RHQ", async () => {
    const rhq = rhqStub({ periods: periods(), writes: [failedImport()] })
    const w = pushWorld({ rhq })
    await stagedLog(w, "2026-08")
    const actions = createSnapshotActions(w.deps)
    expect(await actions.checkImports()).toMatchObject({ ok: true, attemptId: null })
    const requests = rhq.sent.length
    expect(gets(rhq)).toEqual(["2026-08"])
    expect(await actions.checkImports()).toMatchObject({ ok: false, problem: { code: "check_rate_limited" } })
    expect(rhq.sent).toHaveLength(requests)
  })
})
