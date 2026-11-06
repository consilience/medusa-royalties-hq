import {
  addMonths,
  cycleOf,
  hasEnded,
  monthIndex,
  periodRange,
  periodsDue,
  pushAtFor,
  pushOffsetMinutes,
  refundCutoffFor,
  scheduledCutoffFor,
  toEpochMillis,
  validateSchedule,
  type Period,
  type PeriodStatus,
  type Schedule,
} from "../../period";

const monthly = (timezone: string, pushDay = 15): Schedule => ({
  frequencyMonths: 1,
  anchorMonth: 1,
  pushDay,
  timezone,
});

const plusMinutes = (iso: string, minutes: number) =>
  new Date(toEpochMillis(iso) + minutes * 60_000).toISOString();

const SHOP = "poppy-press.example.com";

describe("validateSchedule", () => {
  it("accepts the documented ranges", () => {
    expect(() => validateSchedule(monthly("UTC"))).not.toThrow();
    expect(() =>
      validateSchedule({
        frequencyMonths: 12,
        anchorMonth: 12,
        pushDay: 28,
        timezone: "Pacific/Auckland",
      }),
    ).not.toThrow();
  });

  it.each([
    { frequencyMonths: 0 },
    { frequencyMonths: 13 },
    { frequencyMonths: 1.5 },
    { anchorMonth: 0 },
    { anchorMonth: 13 },
    { pushDay: 0 },
    // 29–31 do not exist in every month, so a push date would drift.
    { pushDay: 29 },
    { timezone: "Not/AZone" },
  ])("rejects %j", (bad) => {
    expect(() => validateSchedule({ ...monthly("UTC"), ...bad })).toThrow();
  });
});

describe("cycleOf", () => {
  it("monthly: each month is its own cycle", () => {
    expect(cycleOf("2026-08", monthly("UTC"))).toEqual({
      first: "2026-08",
      last: "2026-08",
      months: ["2026-08"],
    });
  });

  it("6-monthly anchored in January gives Jan–Jun and Jul–Dec", () => {
    const s = { ...monthly("UTC"), frequencyMonths: 6, anchorMonth: 1 };
    expect(cycleOf("2026-03", s)).toEqual({
      first: "2026-01",
      last: "2026-06",
      months: periodRange("2026-01", "2026-06"),
    });
    expect(cycleOf("2026-07", s).first).toBe("2026-07");
    expect(cycleOf("2026-12", s).last).toBe("2026-12");
  });

  it("quarterly anchored in April puts February in Jan–Mar", () => {
    const s = { ...monthly("UTC"), frequencyMonths: 3, anchorMonth: 4 };
    expect(cycleOf("2026-02", s)).toMatchObject({
      first: "2026-01",
      last: "2026-03",
    });
  });

  it("yearly anchored in July straddles the calendar year", () => {
    const s = { ...monthly("UTC"), frequencyMonths: 12, anchorMonth: 7 };
    expect(cycleOf("2026-03", s)).toMatchObject({
      first: "2025-07",
      last: "2026-06",
    });
  });

  it("5-monthly (does not divide 12) is continuous across years, from a fixed epoch", () => {
    const s = { ...monthly("UTC"), frequencyMonths: 5, anchorMonth: 1 };
    // Month index = year × 12 + month − 1, so January starts a cycle in years
    // divisible by 5 and the sequence rolls on unbroken between them.
    expect(cycleOf("2025-01", s)).toMatchObject({
      first: "2025-01",
      last: "2025-05",
    });
    expect(cycleOf("2025-12", s)).toMatchObject({
      first: "2025-11",
      last: "2026-03",
    });
    expect(cycleOf("2026-09", s)).toMatchObject({
      first: "2026-09",
      last: "2027-01",
    });
    expect(cycleOf("2030-01", s).first).toBe("2030-01");
  });

  it("tiles months with no gaps or overlaps for every frequency and anchor", () => {
    for (let f = 1; f <= 12; f++) {
      for (let a = 1; a <= 12; a++) {
        const s = { ...monthly("UTC"), frequencyMonths: f, anchorMonth: a };
        // Start on a cycle boundary; 2019-01 itself need not be one.
        let p: Period = cycleOf("2019-01", s).first;
        let anchorStarts = 0;
        while (monthIndex(p) < monthIndex("2032-01")) {
          const c = cycleOf(p, s);
          expect(c.first).toBe(p);
          expect(c.months).toHaveLength(f);
          expect(c.months[f - 1]).toBe(c.last);
          for (const m of c.months) expect(cycleOf(m, s)).toEqual(c);
          if (p.endsWith(`-${String(a).padStart(2, "0")}`)) anchorStarts++;
          p = addMonths(c.last, 1);
        }
        // The anchor month starts a cycle every year when f divides 12, and
        // at least once in any f-year stretch (f ≤ 11 < 13 years here) otherwise.
        expect(anchorStarts).toBeGreaterThanOrEqual(12 % f === 0 ? 13 : 1);
      }
    }
  });

  it("is independent of the time zone and push day", () => {
    const a = {
      frequencyMonths: 3,
      anchorMonth: 2,
      pushDay: 1,
      timezone: "UTC",
    };
    const b = { ...a, pushDay: 28, timezone: "Pacific/Auckland" };
    expect(cycleOf("2026-05", a)).toEqual(cycleOf("2026-05", b));
  });
});

describe("scheduledCutoffFor", () => {
  it("monthly August 2026 in Auckland is 00:00 on 15 Sep, +12:00", () => {
    expect(scheduledCutoffFor("2026-08", monthly("Pacific/Auckland"))).toBe(
      "2026-09-15T00:00:00+12:00",
    );
  });

  it("every month of a 6-month cycle shares the push date after its last month", () => {
    const s = {
      ...monthly("Europe/London"),
      frequencyMonths: 6,
      anchorMonth: 1,
    };
    for (const p of periodRange("2026-01", "2026-06")) {
      expect(scheduledCutoffFor(p, s)).toBe("2026-07-15T00:00:00+01:00");
    }
    // Jul–Dec pushes on 15 January of the next year.
    for (const p of periodRange("2026-07", "2026-12")) {
      expect(scheduledCutoffFor(p, s)).toBe("2027-01-15T00:00:00+00:00");
    }
    expect(
      scheduledCutoffFor("2026-10", { ...s, timezone: "Pacific/Auckland" }),
    ).toBe("2027-01-15T00:00:00+13:00");
  });

  it("December monthly pushes in January of the next year", () => {
    expect(scheduledCutoffFor("2026-12", monthly("UTC", 1))).toBe(
      "2027-01-01T00:00:00Z",
    );
  });

  it("5-monthly across a year boundary", () => {
    const s = { ...monthly("UTC", 10), frequencyMonths: 5, anchorMonth: 1 };
    // 2026-09..2027-01 → push 10 Feb 2027.
    expect(scheduledCutoffFor("2026-11", s)).toBe("2027-02-10T00:00:00Z");
  });

  it("follows the local offset either side of a DST change", () => {
    // London springs forward on 29 Mar 2026.
    expect(scheduledCutoffFor("2026-02", monthly("Europe/London"))).toBe(
      "2026-03-15T00:00:00+00:00",
    );
    expect(scheduledCutoffFor("2026-03", monthly("Europe/London"))).toBe(
      "2026-04-15T00:00:00+01:00",
    );
    // Auckland falls back at 03:00 on 5 Apr 2026: midnight is still NZDT.
    expect(scheduledCutoffFor("2026-03", monthly("Pacific/Auckland", 5))).toBe(
      "2026-04-05T00:00:00+13:00",
    );
    // Auckland springs forward at 02:00 on 27 Sep 2026: midnight is still NZST.
    expect(scheduledCutoffFor("2026-08", monthly("Pacific/Auckland", 27))).toBe(
      "2026-09-27T00:00:00+12:00",
    );
  });

  it("uses the first instant of the push day when local midnight does not exist", () => {
    // Chile springs forward at 24:00 on 5 Sep 2026; the 6th starts at 01:00.
    expect(scheduledCutoffFor("2026-08", monthly("America/Santiago", 6))).toBe(
      "2026-09-06T01:00:00-03:00",
    );
  });

  it("uses the earlier midnight when local midnight happens twice", () => {
    // Cuba falls back at 01:00 on 1 Nov 2026.
    expect(scheduledCutoffFor("2026-10", monthly("America/Havana", 1))).toBe(
      "2026-11-01T00:00:00-04:00",
    );
  });
});

describe("refundCutoffFor", () => {
  const s = monthly("Pacific/Auckland");

  it("is the scheduled cut-off when nothing is recorded", () => {
    expect(refundCutoffFor("2026-08", s)).toBe("2026-09-15T00:00:00+12:00");
    expect(refundCutoffFor("2026-08", s, new Map())).toBe(
      "2026-09-15T00:00:00+12:00",
    );
  });

  it("prefers the recorded cut-off, even after the schedule changed", () => {
    const recorded = new Map<Period, string>([
      ["2026-08", "2026-09-20T00:00:00+12:00"],
    ]);
    expect(refundCutoffFor("2026-08", s, recorded)).toBe(
      "2026-09-20T00:00:00+12:00",
    );
    expect(refundCutoffFor("2026-07", s, recorded)).toBe(
      "2026-08-15T00:00:00+12:00",
    );
  });
});

describe("pushAtFor", () => {
  it("is the cut-off plus the shop's jitter (01:00–05:59 local)", () => {
    const s = monthly("Pacific/Auckland");
    const offset = pushOffsetMinutes(SHOP);
    const pushAt = pushAtFor("2026-08", s, SHOP);
    expect(
      toEpochMillis(pushAt) - toEpochMillis("2026-09-15T00:00:00+12:00"),
    ).toBe(offset * 60_000);
    expect(pushAt.startsWith("2026-09-15T0")).toBe(true);
    expect(pushAt.endsWith("+12:00")).toBe(true);
    expect(pushAtFor("2026-08", s, SHOP)).toBe(pushAt);
  });
});

describe("hasEnded", () => {
  it("Auckland: ended locally at 00:30 on the 1st, but not in UTC until 12 hours later", () => {
    expect(
      hasEnded("2026-08", "Pacific/Auckland", "2026-09-01T00:30:00+12:00"),
    ).toBe(false);
    expect(
      hasEnded("2026-08", "Pacific/Auckland", "2026-08-31T23:59:59Z"),
    ).toBe(false);
    expect(
      hasEnded("2026-08", "Pacific/Auckland", "2026-09-01T00:00:00Z"),
    ).toBe(true);
  });

  it("New York: ended in UTC at midnight Z, but not locally until 04:00Z", () => {
    expect(
      hasEnded("2026-08", "America/New_York", "2026-09-01T02:00:00Z"),
    ).toBe(false);
    expect(
      hasEnded("2026-08", "America/New_York", "2026-09-01T04:00:00Z"),
    ).toBe(true);
  });

  it("the current month has not ended", () => {
    expect(hasEnded("2026-09", "UTC", "2026-09-27T12:00:00Z")).toBe(false);
    expect(hasEnded("2026-08", "UTC", "2026-09-27T12:00:00Z")).toBe(true);
  });
});

describe("periodsDue", () => {
  const none = new Map<Period, PeriodStatus>();

  it("returns every month whose push instant has passed, oldest first", () => {
    const s = monthly("Pacific/Auckland");
    const opts = { storeKey: SHOP, backfillStart: "2026-06", statuses: none };
    expect(periodsDue("2026-09-20T12:00:00+12:00", s, opts)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    expect(periodsDue("2026-09-14T12:00:00+12:00", s, opts)).toEqual([
      "2026-06",
      "2026-07",
    ]);
  });

  it("switches on at the jittered push instant, not at the cut-off", () => {
    const s = monthly("Europe/London");
    const opts = { storeKey: SHOP, backfillStart: "2026-08", statuses: none };
    const pushAt = pushAtFor("2026-08", s, SHOP);
    expect(periodsDue("2026-09-15T00:00:00+01:00", s, opts)).toEqual([]);
    expect(periodsDue(plusMinutes(pushAt, -1), s, opts)).toEqual([]);
    expect(periodsDue(pushAt, s, opts)).toEqual(["2026-08"]);
  });

  it("excludes imported periods only; staged and rejected are re-offered", () => {
    const statuses = new Map<Period, PeriodStatus>([
      ["2026-08", "rejected"],
      ["2026-05", "imported"],
      ["2026-07", "staged"],
    ]);
    expect(
      periodsDue("2026-09-20T12:00:00Z", monthly("UTC"), {
        storeKey: SHOP,
        backfillStart: "2026-04",
        statuses,
      }),
    ).toEqual(["2026-04", "2026-06", "2026-07", "2026-08"]);
  });

  it("backfill months whose cycle push date has passed are due at once; the open cycle waits", () => {
    const s = {
      ...monthly("Europe/London"),
      frequencyMonths: 6,
      anchorMonth: 1,
    };
    const due = periodsDue("2026-09-20T12:00:00+01:00", s, {
      storeKey: SHOP,
      backfillStart: "2025-01",
      statuses: none,
    });
    // Jan 2025–Jun 2026 (pushes on 15 Jul 2025, 15 Jan 2026, 15 Jul 2026);
    // Jul–Aug 2026 wait for 15 Jan 2027 although they have ended.
    expect(due).toEqual(periodRange("2025-01", "2026-06"));
  });

  it("starts at the first ledger period when that is later than the backfill start", () => {
    const s = monthly("UTC");
    const base = { storeKey: SHOP, statuses: none };
    expect(
      periodsDue("2026-09-20T12:00:00Z", s, {
        ...base,
        backfillStart: "2026-01",
        firstLedgerPeriod: "2026-06",
      }),
    ).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(
      periodsDue("2026-09-20T12:00:00Z", s, {
        ...base,
        backfillStart: "2026-07",
        firstLedgerPeriod: "2026-01",
      }),
    ).toEqual(["2026-07", "2026-08"]);
  });

  it("is empty when the backfill start is in the future", () => {
    expect(
      periodsDue("2026-09-20T12:00:00Z", monthly("UTC"), {
        storeKey: SHOP,
        backfillStart: "2026-10",
        statuses: none,
      }),
    ).toEqual([]);
  });

  it("holds a month whose push instant passed locally until it has also ended in UTC", () => {
    // UTC+14 with push day 1: the push lands on 31 Aug in UTC.
    const s = monthly("Pacific/Kiritimati", 1);
    const opts = { storeKey: SHOP, backfillStart: "2026-08", statuses: none };
    const pushAt = pushAtFor("2026-08", s, SHOP);
    expect(toEpochMillis(pushAt)).toBeLessThan(
      toEpochMillis("2026-09-01T00:00:00Z"),
    );
    expect(periodsDue(plusMinutes(pushAt, 1), s, opts)).toEqual([]);
    expect(periodsDue("2026-09-01T00:00:00Z", s, opts)).toEqual(["2026-08"]);
  });

  it("ignores the last pushed hash (re-push is decided on the built payload)", () => {
    const opts = {
      storeKey: SHOP,
      backfillStart: "2026-08",
      statuses: new Map<Period, PeriodStatus>([["2026-08", "staged"]]),
      lastPushedHash: new Map<Period, string>([["2026-08", "abc"]]),
    };
    expect(periodsDue("2026-09-20T12:00:00Z", monthly("UTC"), opts)).toEqual([
      "2026-08",
    ]);
  });
});
