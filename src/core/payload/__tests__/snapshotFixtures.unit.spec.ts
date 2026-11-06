import { buildSnapshot, MAX_SNAPSHOT_ROWS } from "../../payload";
import { payloadErrors } from "../../__tests__/support/wireChecks";
import { loadSnapshotFixture, snapshotFixtureFiles } from "../../__tests__/support/snapshotFixtures";

// The snapshot fixtures, end to end: CoreOrder JSON in, PayloadV1
// out.

const GENERATED_AT = "2026-09-20T02:00:00Z";

describe.each(snapshotFixtureFiles())("snapshot fixture %s", (file) => {
  const fx = loadSnapshotFixture(file);
  const result = buildSnapshot({
    period: fx.period,
    orders: fx.orders,
    orphanRefunds: fx.orphanRefunds,
    products: fx.products,
    settings: fx.settings,
    recordedCutoffs: fx.recordedCutoffs,
    // No fixture models a committed period; the late-refund rule has its
    // own tests in attribution.unit.spec.ts and buildSnapshot.unit.spec.ts.
    committedPeriods: new Set(),
    refundsAlreadyPushed: new Map(),
    moneyOnlyRefundsAlreadyReported: new Map(),
    appliedMoneyOnlyRefundIds: new Map(),
    ordersAlreadyPushed: new Map(),
    generatedAt: GENERATED_AT,
    clientVersion: "0.1.0",
    maxRows: MAX_SNAPSHOT_ROWS,
  });

  it("has a description", () => {
    expect(fx.description.length).toBeGreaterThan(0);
  });

  it("builds the expected rows", () => {
    expect(result.payload.rows).toEqual(fx.expected.rows);
  });

  it("builds the expected summary", () => {
    expect(result.payload.summary).toEqual(fx.expected.summary);
  });

  (fx.expected.settings !== undefined ? it : it.skip)(
    "records the expected settings block",
    () => {
      expect(result.payload.settings).toEqual(fx.expected.settings);
    },
  );

  it("fills the envelope", () => {
    expect(result.payload.schema_version).toBe(1);
    expect(result.payload.period).toBe(fx.period);
    expect(result.payload.store_timezone).toBe(fx.settings.timezone);
    expect(result.payload.generated_at).toBe(GENERATED_AT);
    expect(result.payload.client).toEqual({
      platform: "medusa",
      version: "0.1.0",
    });
    expect(result.rowCountError).toBeUndefined();
  });

  it("passes the wire checks", () => {
    expect(payloadErrors(result.payload)).toEqual([]);
  });
});
