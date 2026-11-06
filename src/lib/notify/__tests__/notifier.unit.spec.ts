import type { PushNotice } from "../../push/push"
import { DEFAULT_SETTINGS, type StoredSettings } from "../../settings/settings"
import { createPushNotifier, NOTICE_KEY } from "../notifier"

// The admin feed always, and email to notify_emails through the
// Notification Module's email channel. Plain-text data any provider can
// render. Failures are logged and never thrown: the push already happened.

function world(opts: { emails?: string[]; fail?: (n: any) => boolean } = {}) {
  const sent: any[] = []
  const logs: Record<string, unknown>[] = []
  const state = new Map<string, unknown>()
  const settings: StoredSettings = { ...DEFAULT_SETTINGS, notify_emails: opts.emails ?? ["royalties@example.test"] }
  const notify = createPushNotifier({
    notifications: {
      createNotifications: async (n: any) => {
        if (opts.fail?.(n)) throw new Error("provider down")
        sent.push(n)
        return n
      },
    },
    state: {
      readState: async <T>(k: string) => (state.get(k) as T) ?? null,
      writeState: async (k: string, v: unknown) => void state.set(k, v),
    },
    settings: async () => settings,
    logger: (e) => logs.push(e),
  })
  return { notify, sent, logs, state }
}

const acceptedNotice = (over: Partial<PushNotice> = {}): PushNotice => ({
  attemptId: "att_1",
  period: "2026-10",
  kind: "accepted",
  rowCount: 3,
  totals: { EUR: "41.50" },
  problem: null,
  stop: false,
  retryAt: null,
  holdBackReasons: [],
  importUrl: "https://rhq.example.test/imports/12",
  ...over,
})
const problemNotice = (code = "rate_limited", over: Partial<PushNotice> = {}): PushNotice => ({
  ...acceptedNotice(),
  kind: "problem",
  importUrl: null,
  problem: { code, title: "Too many requests", detail: "Slow down.", status: 429 },
  retryAt: new Date("2026-11-15T03:10:00Z"),
  ...over,
})

describe("createPushNotifier", () => {
  it("puts an accepted month in the admin feed and emails each address", async () => {
    const w = world({ emails: ["a@example.test", "b@example.test"] })
    await w.notify(acceptedNotice())
    const feed = w.sent.filter((n) => n.channel === "feed")
    const email = w.sent.filter((n) => n.channel === "email")
    expect(feed).toEqual([{ to: "", channel: "feed", template: "admin-ui", data: { title: expect.stringContaining("2026-10"), description: expect.stringContaining("EUR 41.50") } }])
    expect(email.map((n) => n.to)).toEqual(["a@example.test", "b@example.test"])
    expect(email[0]).toMatchObject({ template: "royalties-hq-push-accepted", data: { period: "2026-10", subject: expect.stringContaining("2026-10") } })
    expect(email[0].data.text).toContain("3 rows")
    expect(email[0].data.text).toContain("https://rhq.example.test/imports/12")
  })

  it("explains a problem, with when it will try again or that sending has stopped", async () => {
    const w = world()
    await w.notify(problemNotice())
    const email = w.sent.find((n) => n.channel === "email")
    expect(email.template).toBe("royalties-hq-push-problem")
    expect(email.data.text).toContain("Too many requests")
    expect(email.data.text).toContain("Slow down.")
    expect(email.data.text).toContain("2026-11-15T03:10:00.000Z")

    const s = world()
    await s.notify(problemNotice("store_mismatch", { stop: true, retryAt: null }))
    expect(s.sent.find((n) => n.channel === "email").data.text).toMatch(/stopped/i)
  })

  it("tells of a problem once while it repeats, and again after the month has gone", async () => {
    const w = world()
    await w.notify(problemNotice())
    await w.notify(problemNotice())
    expect(w.sent.filter((n) => n.channel === "feed")).toHaveLength(1)
    await w.notify(acceptedNotice())
    await w.notify(problemNotice())
    expect(w.sent.filter((n) => n.channel === "feed")).toHaveLength(3)
    // A different problem with the same month is news.
    await w.notify(problemNotice("server_error"))
    expect(w.sent.filter((n) => n.channel === "feed")).toHaveLength(4)
  })

  it("keeps going when one send fails, and logs it without the address", async () => {
    const w = world({ emails: ["a@example.test", "b@example.test"], fail: (n) => n.to === "a@example.test" })
    await expect(w.notify(acceptedNotice())).resolves.toBeUndefined()
    expect(w.sent.map((n) => n.to)).toEqual(["", "b@example.test"])
    expect(w.logs).toEqual([expect.objectContaining({ event: "notify.failed", channel: "email" })])
    expect(JSON.stringify(w.logs)).not.toContain("a@example.test")
  })

  it("sends only to the feed when no addresses are set", async () => {
    const w = world({ emails: [] })
    await w.notify(acceptedNotice())
    expect(w.sent.map((n) => n.channel)).toEqual(["feed"])
  })

  it("remembers what it last said per month", async () => {
    const w = world()
    await w.notify(problemNotice())
    expect(w.state.get(NOTICE_KEY)).toEqual({ "2026-10": "problem:rate_limited:retry" })
  })

  it("still says when retrying has given up, after notices that it would try again", async () => {
    const w = world()
    await w.notify(problemNotice())
    await w.notify(problemNotice("rate_limited", { retryAt: null }))
    const feed = w.sent.filter((n) => n.channel === "feed")
    expect(feed).toHaveLength(2)
    expect(feed[1].data.description).toMatch(/push it again/)
  })

  it("does not count a notice as given when every send failed, so the next one tries again", async () => {
    let down = true
    const w = world({ emails: [], fail: () => down })
    await w.notify(problemNotice())
    down = false
    await w.notify(problemNotice())
    expect(w.sent.filter((n) => n.channel === "feed")).toHaveLength(1)
  })
})
