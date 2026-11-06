import { validateSettings } from "../../core/settings/validate"
import type { CoreSettings } from "../../core/types"
import type { IsbnSource } from "../../core/identity"
import { isPeriod } from "../../core/period"
import { rhqNetworkPolicy } from "../net/safeFetch"

/** One rhq_settings row's data, as the admin edits it. */
export type StoredSettings = {
  enabled: boolean
  base_url: string | null
  timezone: string | null
  sale_country: string | null
  commission_percent: string | null
  card_fee_mode: "none" | "flat" | "actual"
  card_fee_flat_percent: string | null
  commission_excludes_fees_confirmed: boolean
  include_shipping: boolean
  bundle_split: "price_ratio" | "even"
  frequency_months: number
  anchor_month: number
  push_day: number
  push_mode: "automatic" | "manual"
  isbn_source: IsbnSource
  notify_emails: string[]
  /** The first month the schedule sends (YYYY-MM); manual mode offers nothing earlier either. */
  start_month: string | null
}

export const DEFAULT_SETTINGS: StoredSettings = Object.freeze({
  enabled: false,
  base_url: null,
  timezone: null,
  sale_country: null,
  commission_percent: null,
  card_fee_mode: "none",
  card_fee_flat_percent: null,
  commission_excludes_fees_confirmed: false,
  include_shipping: false,
  bundle_split: "price_ratio",
  frequency_months: 1,
  anchor_month: 1,
  push_day: 15,
  push_mode: "automatic",
  isbn_source: "auto",
  notify_emails: Object.freeze([]) as unknown as string[],
  start_month: null,
}) as StoredSettings

export type SettingsFieldError = { field: keyof StoredSettings | "token"; code: string; message: string }

const CORE_TO_STORED: Record<keyof CoreSettings, keyof StoredSettings> = {
  commissionPercent: "commission_percent",
  cardFeeMode: "card_fee_mode",
  flatFeePercent: "card_fee_flat_percent",
  commissionExcludesFeesConfirmed: "commission_excludes_fees_confirmed",
  includeShipping: "include_shipping",
  bundleSplit: "bundle_split",
  bundleFallback: "bundle_split",
  frequencyMonths: "frequency_months",
  anchorMonth: "anchor_month",
  pushDay: "push_day",
  timezone: "timezone",
  saleCountry: "sale_country",
  pushMode: "push_mode",
}

const ISBN_SOURCES: readonly string[] = ["auto", "ean", "barcode", "upc", "sku"]
// Manual composition has no platform allocation, so it is not offered.
const BUNDLE_SPLITS: readonly string[] = ["price_ratio", "even"]
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function toCoreSettings(s: StoredSettings): CoreSettings {
  return {
    commissionPercent: s.commission_percent,
    cardFeeMode: s.card_fee_mode,
    flatFeePercent: s.card_fee_flat_percent,
    commissionExcludesFeesConfirmed: s.commission_excludes_fees_confirmed,
    includeShipping: s.include_shipping,
    bundleSplit: s.bundle_split,
    // Only reached when platform_allocation's guard fails, which Medusa never uses.
    bundleFallback: "price_ratio",
    frequencyMonths: s.frequency_months,
    anchorMonth: s.anchor_month,
    pushDay: s.push_day,
    timezone: s.timezone ?? "",
    saleCountry: s.sale_country ?? "",
    pushMode: s.push_mode,
  }
}

function baseUrlError(raw: string, env: Record<string, string | undefined>): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return "invalid"
  }
  if (url.username || url.password || url.search || url.hash) return "invalid"
  if (!url.pathname.replace(/\/+$/, "").endsWith("/api/v1")) return "invalid"
  if (url.protocol === "https:") return null
  // The transport's own policy, so a URL that validates is never one every
  // push then refuses.
  if (url.protocol === "http:") return rhqNetworkPolicy(env).allowHttp ? null : "https_required"
  return "invalid"
}

/**
 * Every problem with a settings change, against the stored field names the
 * admin form uses. Unset timezone and country are only errors when enabling,
 * so a store can save partial settings while it gets a token.
 */
export function validateSettingsChange(
  s: StoredSettings,
  { tokenSet, env }: { tokenSet: boolean; env: Record<string, string | undefined> },
): SettingsFieldError[] {
  const errors: SettingsFieldError[] = []
  const add = (field: SettingsFieldError["field"], code: string, message: string) => errors.push({ field, code, message })
  const blank = (v: string | null) => v === null || v.trim() === ""

  if (s.enabled) {
    if (blank(s.base_url)) add("base_url", "required", "Enter the Royalties HQ API base URL.")
    if (!tokenSet) add("token", "required", "Set an API token.")
    if (blank(s.timezone)) add("timezone", "required", "Choose the store's timezone.")
    if (blank(s.sale_country)) add("sale_country", "required", "Choose the store's country.")
    if (blank(s.start_month)) add("start_month", "required", "Choose the first month to send.")
  }
  if (!blank(s.start_month) && !isPeriod(s.start_month!)) add("start_month", "invalid", "Enter the month as YYYY-MM.")
  if (!blank(s.base_url)) {
    const code = baseUrlError(s.base_url!, env)
    if (code === "https_required") add("base_url", code, "The base URL must use https.")
    else if (code) add("base_url", code, "Enter the API base URL shown in Royalties HQ, ending /api/v1.")
  }

  if (!BUNDLE_SPLITS.includes(s.bundle_split)) add("bundle_split", "invalid", "Choose price ratio or even.")
  if (!ISBN_SOURCES.includes(s.isbn_source)) add("isbn_source", "invalid", "Unknown ISBN source.")
  if (!Array.isArray(s.notify_emails) || s.notify_emails.some((e) => typeof e !== "string" || !EMAIL.test(e))) {
    add("notify_emails", "invalid", "Enter valid email addresses.")
  }

  for (const e of validateSettings(toCoreSettings(s))) {
    const field = CORE_TO_STORED[e.field]
    if (field === "bundle_split") continue
    if ((field === "timezone" || field === "sale_country") && blank(s[field])) continue
    add(field, e.code, e.message)
  }
  return errors
}
