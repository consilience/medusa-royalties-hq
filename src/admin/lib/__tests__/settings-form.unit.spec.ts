import { feeOptions, lastMonth } from "../settings-form"

// The settings page's own decisions, kept out of the component so they are
// tested: the default first month to send, and which fee modes it offers.

describe("lastMonth", () => {
  it("is the month before this one in the store's zone, not the browser's", () => {
    // 23:30 UTC on 31 Oct is already 1 Nov in Tokyo.
    const now = new Date("2026-10-31T23:30:00Z")
    expect(lastMonth("Asia/Tokyo", now)).toBe("2026-10")
    expect(lastMonth("UTC", now)).toBe("2026-09")
  })

  it("goes back across a year end", () => {
    expect(lastMonth("Europe/London", new Date("2027-01-05T12:00:00Z"))).toBe("2026-12")
  })

  it("falls back to the browser's zone for a zone it does not know", () => {
    expect(lastMonth("Mars/Olympus", new Date("2026-10-15T12:00:00Z"))).toMatch(/^2026-09$/)
  })
})

describe("feeOptions", () => {
  it("offers no actual fees for a new choice: the plugin cannot read them", () => {
    expect(feeOptions("none").map(([v]) => v)).toEqual(["none", "flat"])
  })

  it("keeps a stored actual-fees mode on offer, so saving does not change it", () => {
    expect(feeOptions("actual").map(([v]) => v)).toEqual(["none", "flat", "actual"])
  })
})
