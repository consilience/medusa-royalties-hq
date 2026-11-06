import { forgetConnection, recordTestedConnection } from "../../admin/status"
import { periodCsv } from "../csv"
import { STATE_KEYS } from "../store"
import { pushPeriod } from "../push"
import { accepted, ISBN, pushWorld, rhqStub } from "./support/world"

// Download CSV: the snapshot a push would build, in RHQ's sales import
// template, for a publisher who checks the figures or imports by hand. It
// needs no connection and sends nothing.

const lines = (csv: string) => csv.replace(/^﻿/, "").trim().split("\r\n")

describe("periodCsv", () => {
  it("builds the month from the store's orders, with no connection and no request to RHQ", async () => {
    const rhq = rhqStub()
    const w = pushWorld({ rhq })
    const csv = await periodCsv(w.deps, "2026-08")
    expect(csv.filename).toBe("royalties-hq-2026-08.csv")
    expect(csv.rowCount).toBe(1)
    expect(lines(csv.body)).toHaveLength(2)
    expect(lines(csv.body)[1]).toContain(ISBN)
    expect(rhq.sent).toEqual([])
  })

  it("uses the cut-off a push recorded for the month, so it matches what RHQ holds", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", { mode: "live", trigger: "manual" })
    const seen = w.loads.length
    await periodCsv(w.deps, "2026-08")
    expect(w.loads[seen]!.refundCutoffAt).toBe(w.loads[seen - 1]!.refundCutoffAt)
  })

  it("in manual mode treats an unpushed month as pushed now", async () => {
    const w = pushWorld({ rhq: rhqStub(), settings: { push_mode: "manual" } })
    w.setNow("2026-09-20T12:34:56.000Z")
    await periodCsv(w.deps, "2026-08")
    expect(w.loads.at(-1)!.refundCutoffAt).toBe("2026-09-20T13:34:56+01:00")
  })

  it("uses the connection's marketplace once a push has read it", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", { mode: "live", trigger: "manual" })
    expect(lines((await periodCsv(w.deps, "2026-08")).body)[1]).toContain("Acme Shop")
  })

  it("refuses before the settings are saved", async () => {
    const w = pushWorld({ rhq: rhqStub() })
    w.store.data.settings.length = 0
    await expect(periodCsv(w.deps, "2026-08")).rejects.toThrow(/settings/i)
  })

  it("refuses while the token's connection is unconfirmed, rather than build without the history it would use", async () => {
    const rhq = rhqStub({ writes: [accepted("created")] })
    const w = pushWorld({ rhq })
    await pushPeriod(w.deps, "2026-08", { mode: "live", trigger: "manual" })
    const known = (await w.store.readState<{ id: number; marketplace: string }>(STATE_KEYS.connection))!
    await forgetConnection(w.store, new Date("2026-09-20T12:00:00Z"))
    await expect(periodCsv(w.deps, "2026-08")).rejects.toMatchObject({ code: "connection_unconfirmed" })
    await recordTestedConnection(w.store, { ok: true, connection: { ...known, tokenMode: "live" } })
    await expect(periodCsv(w.deps, "2026-08")).resolves.toMatchObject({ rowCount: 1 })
  })
})
