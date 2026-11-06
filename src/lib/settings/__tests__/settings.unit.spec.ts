import { DEFAULT_SETTINGS, toCoreSettings, validateSettingsChange, type StoredSettings } from "../settings"

const ready: StoredSettings = {
  ...DEFAULT_SETTINGS,
  base_url: "https://acme.example.test/api/v1",
  timezone: "Europe/London",
  sale_country: "GB",
  start_month: "2026-10",
}
const codes = (s: StoredSettings, ctx = { tokenSet: true, env: {} }) => validateSettingsChange(s, ctx).map((e) => `${e.field}:${e.code}`)

describe("settings defaults", () => {
  it("start disabled, automatic, monthly on the 15th, price-ratio bundles, auto ISBN", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      enabled: false,
      push_mode: "automatic",
      frequency_months: 1,
      anchor_month: 1,
      push_day: 15,
      bundle_split: "price_ratio",
      card_fee_mode: "none",
      include_shipping: false,
      isbn_source: "auto",
      notify_emails: [],
    })
  })

  it("validate cleanly when disabled and empty, so a first save of anything works", () => {
    expect(codes(DEFAULT_SETTINGS, { tokenSet: false, env: {} })).toEqual([])
  })
})

describe("enabling", () => {
  it("needs a base URL, a token, a timezone, a sale country and a start month", () => {
    expect(codes({ ...DEFAULT_SETTINGS, enabled: true }, { tokenSet: false, env: {} }).sort()).toEqual(
      ["base_url:required", "sale_country:required", "start_month:required", "timezone:required", "token:required"].sort(),
    )
  })
  it("is allowed once they are all set", () => {
    expect(codes({ ...ready, enabled: true })).toEqual([])
  })
})

describe("start month", () => {
  // The first month the schedule sends: without one the backlog would reach
  // back to whatever month the code guessed.
  it("starts unset", () => {
    expect(DEFAULT_SETTINGS.start_month).toBeNull()
  })
  it("must be a YYYY-MM month", () => {
    expect(codes({ ...ready, start_month: "2026-13" })).toEqual(["start_month:invalid"])
    expect(codes({ ...ready, start_month: "Oct 2026" })).toEqual(["start_month:invalid"])
  })
})

describe("base URL", () => {
  it("must be https", () => {
    expect(codes({ ...ready, base_url: "http://acme.example.test/api/v1" })).toEqual(["base_url:https_required"])
  })
  it("may be http only when local development allows it", () => {
    expect(codes({ ...ready, base_url: "http://127.0.0.1:8080/api/v1" }, { tokenSet: true, env: { ROYALTIES_HQ_ALLOW_HTTP: "true" } })).toEqual([])
  })
  it("is held to https in production whatever the switch says, as the transport is", () => {
    expect(
      codes({ ...ready, base_url: "http://127.0.0.1:8080/api/v1" }, { tokenSet: true, env: { ROYALTIES_HQ_ALLOW_HTTP: "true", NODE_ENV: "production" } }),
    ).toEqual(["base_url:https_required"])
  })
  it("must be the API root, ending /api/v1, with no query or credentials", () => {
    expect(codes({ ...ready, base_url: "https://acme.example.test/" })).toEqual(["base_url:invalid"])
    expect(codes({ ...ready, base_url: "https://u:p@acme.example.test/api/v1" })).toEqual(["base_url:invalid"])
    expect(codes({ ...ready, base_url: "not a url" })).toEqual(["base_url:invalid"])
  })
})

describe("edge-only fields", () => {
  it("refuses platform_allocation: Medusa has no platform bundle allocation", () => {
    expect(codes({ ...ready, bundle_split: "platform_allocation" as any })).toEqual(["bundle_split:invalid"])
  })
  it("refuses an unknown ISBN source", () => {
    expect(codes({ ...ready, isbn_source: "isbn13" as any })).toEqual(["isbn_source:invalid"])
  })
  it("refuses a malformed notification address", () => {
    expect(codes({ ...ready, notify_emails: ["ops@example.test", "nope"] })).toEqual(["notify_emails:invalid"])
  })
  it("refuses a sale country that is not ISO 3166-1 alpha-2", () => {
    expect(codes({ ...ready, sale_country: "GBR" })).toEqual(["sale_country:sale_country_invalid"])
  })
})

describe("core rules, reported against stored field names", () => {
  it("reports the double-deduction guard against commission_excludes_fees_confirmed", () => {
    expect(codes({ ...ready, commission_percent: "15", card_fee_mode: "flat", card_fee_flat_percent: "2" })).toEqual([
      "commission_excludes_fees_confirmed:double_deduction_unconfirmed",
    ])
  })
  it("reports a bad timezone against timezone", () => {
    expect(codes({ ...ready, timezone: "Mars/Olympus" })).toEqual(["timezone:timezone_invalid"])
  })
})

describe("toCoreSettings", () => {
  it("maps stored names to the core's", () => {
    expect(toCoreSettings({ ...ready, commission_percent: "12.5", card_fee_mode: "flat", card_fee_flat_percent: "2", commission_excludes_fees_confirmed: true, push_mode: "manual" })).toEqual({
      commissionPercent: "12.5",
      cardFeeMode: "flat",
      flatFeePercent: "2",
      commissionExcludesFeesConfirmed: true,
      includeShipping: false,
      bundleSplit: "price_ratio",
      bundleFallback: "price_ratio",
      frequencyMonths: 1,
      anchorMonth: 1,
      pushDay: 15,
      timezone: "Europe/London",
      saleCountry: "GB",
      pushMode: "manual",
    })
  })
})
