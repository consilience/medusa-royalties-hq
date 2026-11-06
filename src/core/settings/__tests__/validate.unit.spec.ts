import {
  validateSettings,
  type SettingsErrorCode,
} from "../../settings/validate";
import type { CoreSettings } from "../../types";

const valid: CoreSettings = {
  commissionPercent: null,
  cardFeeMode: "none",
  flatFeePercent: null,
  commissionExcludesFeesConfirmed: false,
  includeShipping: false,
  bundleSplit: "price_ratio",
  bundleFallback: "even",
  frequencyMonths: 1,
  anchorMonth: 1,
  pushDay: 15,
  timezone: "Europe/London",
  saleCountry: "GB",
  pushMode: "automatic",
};

const codes = (overrides: Partial<CoreSettings>): SettingsErrorCode[] =>
  validateSettings({ ...valid, ...overrides }).map((e) => e.code);

describe("validateSettings", () => {
  it("accepts a valid settings object", () => {
    expect(validateSettings(valid)).toEqual([]);
  });

  it("reports each error with its field so the UI can place it", () => {
    const [error] = validateSettings({ ...valid, pushDay: 29 });
    expect(error).toMatchObject({
      code: "push_day_out_of_range",
      field: "pushDay",
    });
    expect(error?.message).toEqual(expect.any(String));
  });

  it("returns every error, not just the first", () => {
    expect(codes({ pushDay: 0, anchorMonth: 13, saleCountry: "gb" })).toEqual(
      expect.arrayContaining([
        "push_day_out_of_range",
        "anchor_month_out_of_range",
        "sale_country_invalid",
      ]),
    );
  });

  describe("commission", () => {
    it.each(["15", "12.5", "0", "100", "8.5000"])("accepts %j", (pct) => {
      expect(codes({ commissionPercent: pct })).toEqual([]);
    });

    it.each(["", "15%", "-1", "100.01", "12,5", "0.00001", "abc"])(
      "rejects %j",
      (pct) => {
        expect(codes({ commissionPercent: pct })).toEqual([
          "commission_percent_invalid",
        ]);
      },
    );
  });

  describe("card fees", () => {
    it("flat mode requires a flat fee percent", () => {
      expect(codes({ cardFeeMode: "flat", flatFeePercent: null })).toEqual([
        "flat_fee_percent_required",
      ]);
    });

    it("flat mode accepts a valid percent", () => {
      expect(codes({ cardFeeMode: "flat", flatFeePercent: "2.9" })).toEqual([]);
    });

    it("rejects a malformed flat fee percent in any mode", () => {
      expect(codes({ cardFeeMode: "flat", flatFeePercent: "2.9%" })).toEqual([
        "flat_fee_percent_invalid",
      ]);
      // Actual mode falls back to the flat percent when the fee is unknown,
      // so a stored bad value would bite later even though it is optional.
      expect(codes({ cardFeeMode: "actual", flatFeePercent: "101" })).toEqual([
        "flat_fee_percent_invalid",
      ]);
    });

    it("actual mode does not require a flat percent", () => {
      expect(codes({ cardFeeMode: "actual", flatFeePercent: null })).toEqual(
        [],
      );
    });

    it("rejects an unknown mode", () => {
      expect(
        codes({ cardFeeMode: "stripe" as CoreSettings["cardFeeMode"] }),
      ).toEqual(["card_fee_mode_invalid"]);
    });
  });

  describe("double-deduction guard", () => {
    it.each(["flat", "actual"] as const)(
      "refuses commission with %s card fees unless confirmed",
      (mode) => {
        expect(
          codes({
            commissionPercent: "15",
            cardFeeMode: mode,
            flatFeePercent: "2.9",
          }),
        ).toEqual(["double_deduction_unconfirmed"]);
      },
    );

    it.each(["flat", "actual"] as const)(
      "allows commission with %s card fees once confirmed",
      (mode) => {
        expect(
          codes({
            commissionPercent: "15",
            cardFeeMode: mode,
            flatFeePercent: "2.9",
            commissionExcludesFeesConfirmed: true,
          }),
        ).toEqual([]);
      },
    );

    it("allows commission alone", () => {
      expect(codes({ commissionPercent: "15", cardFeeMode: "none" })).toEqual(
        [],
      );
    });

    it("allows card fees alone", () => {
      expect(codes({ cardFeeMode: "flat", flatFeePercent: "2.9" })).toEqual([]);
    });

    it("treats a zero commission as no commission", () => {
      expect(
        codes({
          commissionPercent: "0",
          cardFeeMode: "flat",
          flatFeePercent: "2.9",
        }),
      ).toEqual([]);
    });

    it("does not stack a guard error on an already invalid commission", () => {
      expect(
        codes({
          commissionPercent: "abc",
          cardFeeMode: "flat",
          flatFeePercent: "2.9",
        }),
      ).toEqual(["commission_percent_invalid"]);
    });
  });

  describe("commission plus card fee", () => {
    // Both are percentages of the same ex-tax amount, so together above 100%
    // they deduct more than was earned and flip a sale's royalty negative
    // (and a refund's positive, which RHQ refuses).
    const both = {
      commissionExcludesFeesConfirmed: true,
      commissionPercent: "100",
      flatFeePercent: "3",
    };

    it.each(["flat", "actual"] as const)(
      "refuses commission + flat fee above 100 percent in %s mode",
      (mode) => {
        expect(codes({ ...both, cardFeeMode: mode })).toEqual([
          "deductions_exceed_100_percent",
        ]);
      },
    );

    it("allows exactly 100%", () => {
      expect(
        codes({ ...both, cardFeeMode: "flat", commissionPercent: "97" }),
      ).toEqual([]);
    });

    it("ignores the flat percent when no card fee is deducted", () => {
      expect(codes({ ...both, cardFeeMode: "none" })).toEqual([]);
    });
  });

  describe("bundle split", () => {
    it.each(["platform_allocation", "price_ratio", "even"] as const)(
      "accepts split %s",
      (split) => {
        expect(codes({ bundleSplit: split })).toEqual([]);
      },
    );

    it("rejects an unknown split", () => {
      expect(
        codes({ bundleSplit: "weight" as CoreSettings["bundleSplit"] }),
      ).toEqual(["bundle_split_invalid"]);
    });

    it("refuses platform_allocation as its own fallback", () => {
      expect(
        codes({
          bundleFallback:
            "platform_allocation" as CoreSettings["bundleFallback"],
        }),
      ).toEqual(["bundle_fallback_invalid"]);
    });
  });

  describe("schedule", () => {
    it.each([1, 6, 12])("accepts frequency %d", (n) => {
      expect(codes({ frequencyMonths: n })).toEqual([]);
    });
    it.each([0, 13, 1.5, -1])("rejects frequency %d", (n) => {
      expect(codes({ frequencyMonths: n })).toEqual([
        "frequency_months_out_of_range",
      ]);
    });
    it.each([0, 13, 2.5])("rejects anchor month %d", (n) => {
      expect(codes({ anchorMonth: n })).toEqual(["anchor_month_out_of_range"]);
    });
    it.each([1, 28])("accepts push day %d", (n) => {
      expect(codes({ pushDay: n })).toEqual([]);
    });
    it.each([0, 29, 31, 14.5])("rejects push day %d", (n) => {
      expect(codes({ pushDay: n })).toEqual(["push_day_out_of_range"]);
    });
  });

  describe("shop identity", () => {
    it.each(["America/New_York", "Pacific/Auckland", "UTC"])(
      "accepts timezone %s",
      (tz) => {
        expect(codes({ timezone: tz })).toEqual([]);
      },
    );
    // "+03:00": newer ICU builds accept a fixed offset as a zone, but the
    // schedule refuses one (assertTimeZone), so settings must refuse it too.
    it.each(["", "Mars/Olympus", "GMT+25", "+03:00"])("rejects timezone %j", (tz) => {
      expect(codes({ timezone: tz })).toEqual(["timezone_invalid"]);
    });
    it.each(["gb", "GBR", "", "G1"])("rejects sale country %j", (c) => {
      expect(codes({ saleCountry: c })).toEqual(["sale_country_invalid"]);
    });
  });
});
