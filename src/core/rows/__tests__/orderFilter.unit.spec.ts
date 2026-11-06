import {
  isSaleEligible,
  saleEligibility,
} from "../../rows/orderFilter";
import { order } from "../../__tests__/support/builders";

// Stand-in for periodOfInstant(tz) from core/period: the month of an
// instant in the shop's zone, via Intl. Real zone rules, so the boundary
// tests below exercise a genuine offset rather than a faked one.
const periodOfInstantIn =
  (zone: string) =>
  (iso: string): string => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}-${get("month")}`;
  };

const london = periodOfInstantIn("Europe/London");

describe("saleEligibility", () => {
  it.each(["paid", "partially_refunded", "refunded"] as const)(
    "includes a %s order paid in the period",
    (status) => {
      expect(
        saleEligibility(order({ financialStatus: status }), "2026-08", london),
      ).toEqual({ eligible: true });
    },
  );

  it("excludes an order in any other financial state", () => {
    expect(
      saleEligibility(order({ financialStatus: "other" }), "2026-08", london),
    ).toEqual({ eligible: false, reason: "status" });
  });

  it("excludes a test order", () => {
    expect(saleEligibility(order({ test: true }), "2026-08", london)).toEqual({
      eligible: false,
      reason: "test",
    });
  });

  it("excludes an order paid in another period", () => {
    expect(
      saleEligibility(
        order({ paidAt: "2026-09-01T09:00:00+01:00" }),
        "2026-08",
        london,
      ),
    ).toEqual({ eligible: false, reason: "outside_period" });
  });

  it("uses the shop timezone, not UTC, at the month boundary", () => {
    // 23:30 UTC on 31 July is 00:30 BST on 1 August: an August sale for a
    // London shop, a July one for a shop in New York.
    const lateJulyUtc = order({ paidAt: "2026-07-31T23:30:00Z" });
    expect(isSaleEligible(lateJulyUtc, "2026-08", london)).toBe(true);
    expect(isSaleEligible(lateJulyUtc, "2026-07", london)).toBe(false);
    const newYork = periodOfInstantIn("America/New_York");
    expect(isSaleEligible(lateJulyUtc, "2026-07", newYork)).toBe(true);
  });

  it("asks the period function about paidAt and nothing else", () => {
    const seen: string[] = [];
    const spy = (iso: string) => {
      seen.push(iso);
      return "2026-08";
    };
    isSaleEligible(order({ paidAt: "2026-08-03T10:00:00Z" }), "2026-08", spy);
    expect(seen).toEqual(["2026-08-03T10:00:00Z"]);
  });
});
