import { holdBackReasonsOf, holdBackText } from "../holdBack";

describe("holdBackText", () => {
  it("words each hold-back code RHQ sends", () => {
    expect(holdBackText("anomaly")).toMatch(/far out of line/);
    expect(holdBackText("no_baseline")).toMatch(/no imported months/);
    expect(holdBackText("before_backfill_start")).toMatch(
      /before the connection's backfill start month/,
    );
    expect(holdBackText("duplicate_period")).toMatch(
      /may already hold this month's sales/,
    );
  });

  it("does not drop a code it does not know", () => {
    expect(holdBackText("something_new")).toBe(
      "Royalties HQ asked for it to be checked; see the import in Royalties HQ.",
    );
  });

  it("does not treat inherited object keys as codes", () => {
    expect(holdBackText("toString")).toBe(holdBackText("something_new"));
  });
});

describe("holdBackReasonsOf", () => {
  it("keeps the strings of a stored array", () => {
    expect(holdBackReasonsOf(["anomaly", 3, null, "no_baseline"])).toEqual([
      "anomaly",
      "no_baseline",
    ]);
  });

  it("reads anything else as no reasons", () => {
    expect(holdBackReasonsOf(null)).toEqual([]);
    expect(holdBackReasonsOf("anomaly")).toEqual([]);
    expect(holdBackReasonsOf({ 0: "anomaly" })).toEqual([]);
  });
});
