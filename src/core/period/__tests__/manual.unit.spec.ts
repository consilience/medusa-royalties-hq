
import { manualCutoffAt, manuallyPushable } from "../../period";

// Manual push mode: a person pushes one month at a time,
// oldest first, once it has ended and been extracted; its cut-off is the
// moment it is pushed.

const base = {
  timezone: "Europe/London",
  backfillStart: "2026-05",
  extracted: new Set(["2026-05", "2026-06", "2026-07", "2026-08"]),
  accepted: new Set<string>(),
  imported: new Set<string>(),
};
const NOW = "2026-09-20T12:00:00Z";

describe("manuallyPushable", () => {
  it("offers only the oldest month not yet accepted", () => {
    expect(manuallyPushable(NOW, base)).toEqual(["2026-05"]);
  });

  it("offers accepted months again (a re-push) and the next unaccepted one", () => {
    expect(
      manuallyPushable(NOW, {
        ...base,
        accepted: new Set(["2026-05", "2026-06"]),
      }),
    ).toEqual(["2026-05", "2026-06", "2026-07"]);
  });

  it("never offers an imported month, which RHQ refuses", () => {
    expect(
      manuallyPushable(NOW, {
        ...base,
        accepted: new Set(["2026-05", "2026-06"]),
        imported: new Set(["2026-05"]),
      }),
    ).toEqual(["2026-06", "2026-07"]);
  });

  it("stops at an unextracted month: it blocks every later one", () => {
    expect(
      manuallyPushable(NOW, {
        ...base,
        accepted: new Set(["2026-05"]),
        extracted: new Set(["2026-05", "2026-07", "2026-08"]),
      }),
    ).toEqual(["2026-05"]);
  });

  it("offers no month that has not ended in both the shop's zone and UTC", () => {
    // 00:30 on 1 Sep in London is still August in UTC.
    expect(
      manuallyPushable("2026-08-31T23:30:00Z", {
        ...base,
        accepted: new Set(["2026-05", "2026-06", "2026-07"]),
      }),
    ).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(
      manuallyPushable("2026-09-01T00:30:00Z", {
        ...base,
        accepted: new Set(["2026-05", "2026-06", "2026-07"]),
      }),
    ).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
  });

  it("starts at the first ledger month when it is later than the backfill start", () => {
    expect(
      manuallyPushable(NOW, { ...base, firstLedgerPeriod: "2026-07" }),
    ).toEqual(["2026-07"]);
  });
});

describe("manualCutoffAt", () => {
  it("is the push instant, in the shop's zone, to the second", () => {
    expect(manualCutoffAt("2026-09-20T12:34:56.789Z", "Europe/London")).toBe(
      "2026-09-20T13:34:56+01:00",
    );
  });
});
