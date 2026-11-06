import { pushableMonths, rowCount } from "../months"

// Which months offer Push now. Oldest first in either mode: a later month
// pushed before an earlier unsent one fixes its cut-off and late sales out
// of order.

const m = (period: string, status: string | null) => ({ period, status }) as any

describe("pushableMonths", () => {
  const months = [m("2026-10", null), m("2026-09", null), m("2026-08", "staged"), m("2026-07", "imported")]

  it("offers the oldest unsent month and re-pushes of sent ones, never an imported month", () => {
    expect([...pushableMonths(months, { enabled: true })]).toEqual(["2026-09", "2026-08"])
  })

  it("offers nothing while sending is off", () => {
    expect(pushableMonths(months, { enabled: false }).size).toBe(0)
  })
})

describe("rowCount", () => {
  it("says one row, not 1 rows", () => {
    expect(rowCount(1)).toBe("1 row")
    expect(rowCount(3)).toBe("3 rows")
    expect(rowCount(0)).toBe("0 rows")
  })

  it("says nothing for a month never sent", () => {
    expect(rowCount(null)).toBe("")
  })
})
