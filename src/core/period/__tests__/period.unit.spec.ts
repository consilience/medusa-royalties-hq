import {
  addMonths,
  comparePeriods,
  isPeriod,
  localMidnight,
  monthIndex,
  parsePeriod,
  periodEnd,
  periodFromIndex,
  periodOfInstant,
  periodRange,
  periodStart,
  toEpochMillis,
} from "../../period";

describe("parsePeriod / isPeriod", () => {
  it("accepts YYYY-MM", () => {
    expect(parsePeriod("2026-01")).toBe("2026-01");
    expect(parsePeriod("2026-12")).toBe("2026-12");
    expect(isPeriod("1999-07")).toBe(true);
  });

  it.each([
    "2026-13",
    "2026-00",
    "2026-1",
    "26-01",
    " 2026-01",
    "2026-01-01",
    "2026/01",
    "",
  ])("rejects %j", (s) => {
    expect(isPeriod(s)).toBe(false);
    expect(() => parsePeriod(s)).toThrow();
  });
});

describe("month arithmetic", () => {
  it("monthIndex is consecutive across a year boundary and round-trips", () => {
    expect(monthIndex("2026-01") - monthIndex("2025-12")).toBe(1);
    expect(monthIndex("2026-01")).toBe(2026 * 12);
    for (const p of ["2025-12", "2026-01", "2026-06", "0001-01", "9999-12"]) {
      expect(periodFromIndex(monthIndex(p))).toBe(p);
    }
  });

  it("adds and subtracts months across years", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-01", -13)).toBe("2024-12");
    expect(addMonths("2026-05", 0)).toBe("2026-05");
    expect(addMonths("2026-05", 24)).toBe("2028-05");
  });

  it("compares", () => {
    expect(comparePeriods("2025-12", "2026-01")).toBe(-1);
    expect(comparePeriods("2026-01", "2026-01")).toBe(0);
    expect(comparePeriods("2026-02", "2026-01")).toBe(1);
  });

  it("iterates an inclusive range, empty when reversed", () => {
    expect(periodRange("2025-11", "2026-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
    expect(periodRange("2026-02", "2026-02")).toEqual(["2026-02"]);
    expect(periodRange("2026-03", "2026-02")).toEqual([]);
  });
});

describe("periodOfInstant", () => {
  it("23:30 on the last day in a zone behind UTC is that month, though UTC is next month", () => {
    const instant = "2026-08-31T23:30:00-04:00"; // 03:30Z on 1 Sep
    expect(periodOfInstant(instant, "America/New_York")).toBe("2026-08");
    expect(periodOfInstant(instant, "UTC")).toBe("2026-09");
  });

  it("00:30 on the 1st in a zone ahead of UTC is the new month, though UTC is still last month", () => {
    const instant = "2026-09-01T00:30:00+12:00"; // 12:30Z on 31 Aug
    expect(periodOfInstant(instant, "Pacific/Auckland")).toBe("2026-09");
    expect(periodOfInstant(instant, "UTC")).toBe("2026-08");
    // The instant's own offset is irrelevant; only the shop zone decides.
    expect(periodOfInstant("2026-08-31T12:30:00Z", "Pacific/Auckland")).toBe(
      "2026-09",
    );
  });

  it("23:30 local on 31 Jan in Auckland is January though UTC is the same day", () => {
    expect(
      periodOfInstant("2026-01-31T23:30:00+13:00", "Pacific/Auckland"),
    ).toBe("2026-01");
  });

  it("refuses an instant without an offset (it would read in the host's zone)", () => {
    expect(() => periodOfInstant("2026-08-31T23:30:00", "UTC")).toThrow();
    expect(() => toEpochMillis("2026-08-31T23:30:00")).toThrow();
    expect(() => toEpochMillis("not a date")).toThrow();
  });

  it("refuses a fixed offset as a time zone, though newer ICU builds accept one", () => {
    for (const tz of ["+03:00", "-05:00", " +01:00"]) {
      expect(() => periodOfInstant("2026-08-31T23:30:00Z", tz)).toThrow();
    }
  });

  it("reads only extended ISO instants with seconds optional", () => {
    expect(toEpochMillis("2026-08-31T23:30Z")).toBe(Date.UTC(2026, 7, 31, 23, 30));
    expect(toEpochMillis("2026-08-31T23:30:00.123456+01:30")).toBe(
      Date.UTC(2026, 7, 31, 22, 0, 0, 123),
    );
    // Medusa writes "2026-11-04T10:00:00.000Z"; nothing it sends needs more.
    for (const s of [
      "2026-08-31T24:00:00Z",
      "20260831T233000Z",
      "2026-08-31 23:30:00Z",
      "2026-02-30T00:00:00Z",
      "2026-08-31T23:30:00+24:00",
    ]) {
      expect(() => toEpochMillis(s)).toThrow();
    }
  });

  it("refuses an unknown time zone", () => {
    expect(() =>
      periodOfInstant("2026-08-31T23:30:00Z", "Mars/Olympus_Mons"),
    ).toThrow();
  });
});

describe("period start and end in a zone", () => {
  it("starts at local midnight on the 1st and ends (exclusive) at the next 1st", () => {
    expect(periodStart("2026-09", "Pacific/Auckland")).toBe(
      "2026-09-01T00:00:00+12:00",
    );
    // NZ daylight time starts on 27 Sep 2026, so the end carries +13:00.
    expect(periodEnd("2026-09", "Pacific/Auckland")).toBe(
      "2026-10-01T00:00:00+13:00",
    );
    expect(periodStart("2026-04", "Europe/London")).toBe(
      "2026-04-01T00:00:00+01:00",
    );
    expect(periodEnd("2026-12", "Europe/London")).toBe(
      "2027-01-01T00:00:00+00:00",
    );
  });

  it("localMidnight takes the first instant of the day when midnight does not exist", () => {
    // Chile springs forward at 24:00 on Sat 5 Sep 2026: 00:00 on the 6th never happens.
    expect(localMidnight(2026, 9, 6, "America/Santiago")).toBe(
      "2026-09-06T01:00:00-03:00",
    );
  });

  it("localMidnight takes the earlier of two midnights when midnight repeats", () => {
    // Cuba falls back at 01:00 on 1 Nov 2026, so 00:00–00:59 happen twice.
    expect(localMidnight(2026, 11, 1, "America/Havana")).toBe(
      "2026-11-01T00:00:00-04:00",
    );
  });

  it("localMidnight gives the same answer whatever the clock says", () => {
    // A zone library that guesses a repeated wall time from the current offset
    // (Luxon did) fails this only once the real clock passes the transition.
    jest.useFakeTimers();
    try {
      for (const now of ["2026-10-01T12:00:00Z", "2026-11-15T12:00:00Z"]) {
        jest.setSystemTime(new Date(now));
        expect(localMidnight(2026, 11, 1, "America/Havana")).toBe(
          "2026-11-01T00:00:00-04:00",
        );
      }
    } finally {
      jest.useRealTimers();
    }
  });
});
