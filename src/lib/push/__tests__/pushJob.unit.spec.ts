import { PROBLEMS } from "../../rhq/__tests__/support/fakeRhq"
import { PUSH_LOCK_KEY } from "../push"
import { runPushDue } from "../pushJob"
import { accepted, pushWorld, rhqStub, type PushWorld, type RhqStub } from "./support/world"

// A scheduled run: the months found due, pushed oldest first, one at a time,
// stopping or coming back later the way RHQ's answer calls for. The
// reschedule is returned for the
// scheduler to persist rather than handed to a job queue.

const withJuly = (w: PushWorld) => w.ledger.order({ paidAt: "2026-07-10T10:00:00Z", lines: [{ variant: 1, price: 500n }] })
const putPeriods = (rhq: RhqStub) => rhq.sent.filter((r) => r.method === "PUT").map((r) => new URL(r.url).pathname.split("/").pop())

describe("runPushDue", () => {
  it("pushes every due month, oldest first", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" }), accepted("created")] })
    const w = pushWorld({ rhq })
    withJuly(w)
    expect(await runPushDue(w.deps, { periods: ["2026-07", "2026-08"] })).toBeUndefined()
    expect(putPeriods(rhq)).toEqual(["2026-07", "2026-08"])
    expect(w.store.data.snapshots.filter((s) => s.status === "staged")).toHaveLength(2)
  })

  it("starts no further month once the run has been told to stop", async () => {
    const rhq = rhqStub({ writes: [accepted("created", { period: "2026-07" }), accepted("created")] })
    const w = pushWorld({ rhq })
    withJuly(w)
    const controller = new AbortController()
    const fetch = rhq.fetch
    w.deps.rhq = {
      ...w.deps.rhq,
      fetch: async (url, init) => {
        const response = await fetch(url, init)
        if (init.method === "PUT") controller.abort()
        return response
      },
    }
    await runPushDue(w.deps, { periods: ["2026-07", "2026-08"] }, controller.signal)
    expect(putPeriods(rhq)).toEqual(["2026-07"])
  })

  it("comes back at RHQ's Retry-After, keeping the months not yet sent and the retry budget", async () => {
    const rhq = rhqStub({ writes: [{ status: 429, body: PROBLEMS.rateLimited(), headers: { "Retry-After": "30" } }] })
    const w = pushWorld({ rhq })
    withJuly(w)
    expect(await runPushDue(w.deps, { periods: ["2026-07", "2026-08"] })).toEqual({
      rescheduleAt: new Date("2026-09-20T12:00:30.000Z"),
      plan: { periods: ["2026-07", "2026-08"], retry: { period: "2026-07", firstAttemptAt: "2026-09-20T12:00:00.000Z", attempts: 1 } },
    })
    expect(putPeriods(rhq)).toEqual(["2026-07"])
  })

  it("carries the retry state into the next attempt of the same month", async () => {
    const rhq = rhqStub({ writes: [{ status: 500, body: PROBLEMS.serverError() }] })
    const w = pushWorld({ rhq })
    const result = await runPushDue(w.deps, { periods: ["2026-08"], retry: { period: "2026-08", firstAttemptAt: "2026-09-19T11:00:00.000Z", attempts: 12 } })
    // Past the 24 h budget: given up, not rescheduled.
    expect(result).toBeUndefined()
    expect(w.store.data.attempts[0]).toMatchObject({ state: "failed", retry_count: 13, retry_at: null })
  })

  it("moves on to the next month after a problem with this month's data", async () => {
    const rhq = rhqStub({ writes: [{ status: 422, body: PROBLEMS.validationFailed() }, accepted("created")] })
    const w = pushWorld({ rhq })
    withJuly(w)
    await runPushDue(w.deps, { periods: ["2026-07", "2026-08"] })
    expect(putPeriods(rhq)).toEqual(["2026-07", "2026-08"])
  })

  it("stops on an answer that needs a person, even one about a single month", async () => {
    const rhq = rhqStub({ writes: [{ status: 409, body: PROBLEMS.periodCommitted() }, accepted("created")] })
    const w = pushWorld({ rhq })
    withJuly(w)
    expect(await runPushDue(w.deps, { periods: ["2026-07", "2026-08"] })).toBeUndefined()
    expect(putPeriods(rhq)).toEqual(["2026-07"])
  })

  it("stops after a problem with the connection, so one bad token is one notice", async () => {
    const rhq = rhqStub({ handshake: { status: 401, body: PROBLEMS.unauthenticated() } })
    const w = pushWorld({ rhq })
    withJuly(w)
    await runPushDue(w.deps, { periods: ["2026-07", "2026-08"] })
    expect(w.store.data.attempts).toHaveLength(1)
    expect(w.notices).toHaveLength(1)
  })

  it("stops when sending has been switched off since the months were found due", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq, settings: { enabled: false } })
    await runPushDue(w.deps, { periods: ["2026-07", "2026-08"] })
    expect(rhq.sent).toEqual([])
    expect(w.store.data.attempts).toHaveLength(1)
  })

  it("sends nothing in manual mode", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq, settings: { push_mode: "manual" } })
    expect(await runPushDue(w.deps, { periods: ["2026-07", "2026-08"] })).toBeUndefined()
    expect(rhq.sent).toEqual([])
  })

  it("comes back in a minute while a Push now holds the store", async () => {
    const rhq = rhqStub({})
    const w = pushWorld({ rhq })
    w.lock.held.add(PUSH_LOCK_KEY)
    expect(await runPushDue(w.deps, { periods: ["2026-08"] })).toEqual({ rescheduleAt: new Date("2026-09-20T12:01:00.000Z"), plan: { periods: ["2026-08"] } })
  })

  it("refuses a malformed plan for good", async () => {
    const w = pushWorld({ rhq: rhqStub({}) })
    await expect(runPushDue(w.deps, { periods: ["August"] })).rejects.toThrow(/plan/)
  })
})

describe("runPushDue: refusals", () => {
  // Not connected, token unreadable, a deployment hold: the same for every
  // month, and only a person can fix it. Coming back every tick would write
  // a refused attempt every five minutes for as long as it lasts.
  it("comes back in an hour with the months still to send", async () => {
    const rhq = rhqStub()
    const w = pushWorld({ rhq, token: "" })
    w.deps.token = async () => null
    expect(await runPushDue(w.deps, { periods: ["2026-07", "2026-08"] })).toEqual({
      rescheduleAt: new Date("2026-09-20T13:00:00.000Z"),
      plan: { periods: ["2026-07", "2026-08"] },
    })
    expect(w.store.data.attempts).toEqual([expect.objectContaining({ state: "refused", problem_code: "not_connected" })])
  })

  it("tells the publisher once that scheduled sending is refused", async () => {
    const w = pushWorld({ rhq: rhqStub() })
    w.deps.token = async () => null
    await runPushDue(w.deps, { periods: ["2026-07"] })
    expect(w.notices).toEqual([expect.objectContaining({ kind: "problem", period: "2026-07", problem: expect.objectContaining({ code: "not_connected" }), stop: true })])
  })
})
