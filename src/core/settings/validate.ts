import { parsePercent, PERCENT_SCALE } from "../money";
import { isValidZone } from "../period/zone";
import type { CoreSettings } from "../types";

export type SettingsErrorCode =
  | "commission_percent_invalid"
  | "card_fee_mode_invalid"
  | "flat_fee_percent_invalid"
  | "flat_fee_percent_required"
  | "double_deduction_unconfirmed"
  | "deductions_exceed_100_percent"
  | "bundle_split_invalid"
  | "bundle_fallback_invalid"
  | "frequency_months_out_of_range"
  | "anchor_month_out_of_range"
  | "push_day_out_of_range"
  | "push_mode_invalid"
  | "timezone_invalid"
  | "sale_country_invalid";

export interface SettingsError {
  code: SettingsErrorCode;
  field: keyof CoreSettings;
  message: string;
}

const CARD_FEE_MODES: readonly string[] = ["none", "actual", "flat"];
const BUNDLE_SPLITS: readonly string[] = [
  "platform_allocation",
  "price_ratio",
  "even",
];
// platform_allocation is deliberately absent: it is the method whose guard
// failed, so it cannot also be what we fall back to.
const BUNDLE_FALLBACKS: readonly string[] = ["price_ratio", "even"];

/**
 * Checks a settings object and returns every problem found, each with a code
 * and the field it belongs to.
 *
 * Returns rather than throws because the settings UI wants all errors at once,
 * placed against their fields; the row builder, which must never run on bad
 * settings, can treat a non-empty list as fatal itself.
 */
export function validateSettings(settings: CoreSettings): SettingsError[] {
  const errors: SettingsError[] = [];
  const add = (
    code: SettingsErrorCode,
    field: keyof CoreSettings,
    message: string,
  ) => errors.push({ code, field, message });

  const commission = percentOrError(settings.commissionPercent);
  if (commission === "invalid") {
    add(
      "commission_percent_invalid",
      "commissionPercent",
      "Commission must be a percentage from 0 to 100 with at most 4 decimal places.",
    );
  }

  const feeModeValid = CARD_FEE_MODES.includes(settings.cardFeeMode);
  if (!feeModeValid) {
    add("card_fee_mode_invalid", "cardFeeMode", "Unknown card fee mode.");
  }

  // Validated in every mode, not just flat: actual mode falls back to this
  // percent for orders whose fee is unknown, so a bad stored value would only
  // surface later, mid-build.
  const flat = percentOrError(settings.flatFeePercent);
  if (flat === "invalid") {
    add(
      "flat_fee_percent_invalid",
      "flatFeePercent",
      "Card fee must be a percentage from 0 to 100 with at most 4 decimal places.",
    );
  } else if (settings.cardFeeMode === "flat" && flat === null) {
    add(
      "flat_fee_percent_required",
      "flatFeePercent",
      "Enter the flat card fee percentage.",
    );
  }

  // Double-deduction guard: by default commission is taken to
  // cover card fees, so deducting both would charge the author twice for the
  // same cost. Both are allowed only once the user has said the commission
  // does not cover fees. A zero commission deducts nothing, so it cannot
  // double-count and is not treated as "set". An invalid commission already
  // has its own error; stacking a guard error on it would only confuse.
  if (
    typeof commission === "bigint" &&
    commission > 0n &&
    feeModeValid &&
    settings.cardFeeMode !== "none" &&
    !settings.commissionExcludesFeesConfirmed
  ) {
    add(
      "double_deduction_unconfirmed",
      "commissionExcludesFeesConfirmed",
      "Commission normally covers card fees. Confirm that your commission does not include card fees to deduct both.",
    );
  }

  // Commission and the flat fee are each a percentage of the same ex-tax
  // amount, so above 100% together they deduct more than
  // the line earned: a sale's royalty turns negative and its refund's turns
  // positive, which RHQ refuses. Only checked when a card fee is deducted
  // (flat, or actual's fallback); in "none" mode the flat percent is unused.
  if (
    typeof commission === "bigint" &&
    typeof flat === "bigint" &&
    feeModeValid &&
    settings.cardFeeMode !== "none" &&
    commission + flat > 100n * PERCENT_SCALE
  ) {
    add(
      "deductions_exceed_100_percent",
      "flatFeePercent",
      "Commission and card fee together cannot exceed 100%.",
    );
  }

  if (!BUNDLE_SPLITS.includes(settings.bundleSplit)) {
    add("bundle_split_invalid", "bundleSplit", "Unknown bundle split method.");
  }
  if (!BUNDLE_FALLBACKS.includes(settings.bundleFallback)) {
    add(
      "bundle_fallback_invalid",
      "bundleFallback",
      "Bundle fallback must be price ratio or even.",
    );
  }

  if (!isIntegerIn(settings.frequencyMonths, 1, 12)) {
    add(
      "frequency_months_out_of_range",
      "frequencyMonths",
      "Frequency must be a whole number of months from 1 to 12.",
    );
  }
  if (!isIntegerIn(settings.anchorMonth, 1, 12)) {
    add(
      "anchor_month_out_of_range",
      "anchorMonth",
      "Anchor month must be from 1 to 12.",
    );
  }
  // Capped at 28 so every month has the push day; a 31st would silently
  // shift in short months and move the refund cut-off with it.
  if (!isIntegerIn(settings.pushDay, 1, 28)) {
    add("push_day_out_of_range", "pushDay", "Push day must be from 1 to 28.");
  }
  if (settings.pushMode !== "automatic" && settings.pushMode !== "manual") {
    add(
      "push_mode_invalid",
      "pushMode",
      "Choose whether months are sent automatically or by hand.",
    );
  }

  if (!isValidTimeZone(settings.timezone)) {
    add("timezone_invalid", "timezone", "Unknown IANA time zone.");
  }
  // ISO 3166-1 alpha-2, upper case, as RHQ expects; lower case is refused
  // rather than normalised so an edge that forgot to normalise is caught.
  if (!/^[A-Z]{2}$/.test(settings.saleCountry)) {
    add(
      "sale_country_invalid",
      "saleCountry",
      "Sale country must be a two-letter ISO country code.",
    );
  }

  return errors;
}

function percentOrError(text: string | null): bigint | null | "invalid" {
  if (text === null) return null;
  try {
    return parsePercent(text);
  } catch {
    return "invalid";
  }
}

// Counts, not money: these settings are small integers, so number is right.
function isIntegerIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

// The schedule's own check (assertTimeZone), so settings that save are
// settings the schedule accepts: Intl alone would also take a fixed offset
// such as "+03:00" on newer ICU builds, which the schedule refuses.
function isValidTimeZone(zone: string): boolean {
  return isValidZone(zone);
}
