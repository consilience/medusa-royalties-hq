import { snapshotData } from "../../rhq/__tests__/support/fakeRhq"
import { createSnapshotActions, toActionResult } from "../actions"
import { PUSH_LOCK_KEY } from "../push"
import { accepted, puts, pushWorld, rhqStub } from "./support/world"

// What the status page's Validate and Push now show for each outcome of the
// push step: success says honestly what RHQ did (staged, not imported; a
// test-mode token keeps nothing), failures carry RHQ's own code and words.

const acceptedOutcome = { kind: "accepted", attemptId: "rhqatt_7", result: "created", importId: 342, rowCount: 3, ignoredMoneyOnlyRefunds: 0 } as const

describe("toActionResult", () => {
  it("says a live push is staged for review, not imported", () => {
    const r = toActionResult({ ...acceptedOutcome, mode: "live" })
    expect(r).toMatchObject({ ok: true, attemptId: "rhqatt_7" })
    expect(r.ok && r.message).toMatch(/Sent 3 rows .*staged/)
  })

  it("says a test-mode push and a dry run kept nothing", () => {
    const test = toActionResult({ ...acceptedOutcome, mode: "test" })
    expect(test.ok && test.message).toMatch(/Test-mode token.*kept nothing/)
    const dry = toActionResult({ ...acceptedOutcome, mode: "dry_run" })
    expect(dry.ok && dry.message).toMatch(/Nothing was saved \(dry run\)/)
  })

  it("mentions refunds ignored for royalties", () => {
    const r = toActionResult({ ...acceptedOutcome, mode: "live", ignoredMoneyOnlyRefunds: 2 })
    expect(r.ok && r.message).toContain("2 refunds of money outside")
  })

  it("passes RHQ's problem through with the attempt to link to", () => {
    const r = toActionResult({
      kind: "problem",
      attemptId: "rhqatt_9",
      retryAt: null,
      scope: "period",
      stop: false,
      retry: { firstAttemptAt: new Date(), attempts: 1 },
      problem: { code: "validation_failed", title: "The snapshot is not valid.", detail: "Fix the fields.", status: 422 },
    })
    expect(r).toEqual({ ok: false, attemptId: "rhqatt_9", problem: { code: "validation_failed", title: "The snapshot is not valid.", detail: "Fix the fields.", httpStatus: 422 } })
  })

  it("explains a busy store without an attempt", () => {
    expect(toActionResult({ kind: "busy" })).toMatchObject({ ok: false, attemptId: null, problem: { code: "push_in_progress" } })
  })
})

describe("createSnapshotActions", () => {
  it("pushes a month as a person's Push now, and validates as a dry run", async () => {
    const rhq = rhqStub({ writes: [accepted("created"), { status: 202, body: { data: snapshotData({ result: "created", import_id: null }), dry_run: true } }] })
    const w = pushWorld({ rhq })
    const actions = createSnapshotActions(w.deps)
    expect(await actions.push("2026-08")).toMatchObject({ ok: true, message: expect.stringMatching(/^Sent 1 row /) })
    expect(w.store.data.attempts[0]).toMatchObject({ trigger: "manual", mode: "live" })
    expect(await actions.validate("2026-08")).toMatchObject({ ok: true, message: expect.stringMatching(/dry run/) })
    expect(new URL(rhq.sent.at(-1)!.url).pathname).toBe("/api/v1/sales-snapshots/2026-08/validate")
    expect(puts(rhq)).toHaveLength(1)
  })

  it("says someone is pushing while the lock is held", async () => {
    const w = pushWorld({ rhq: rhqStub({}) })
    w.lock.held.add(PUSH_LOCK_KEY)
    expect(await createSnapshotActions(w.deps).push("2026-08")).toMatchObject({ ok: false, problem: { code: "push_in_progress" } })
  })
})
