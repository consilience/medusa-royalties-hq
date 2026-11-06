import { sdk } from "./sdk"

export const BASE = "/admin/royalties-hq"

export type Settings = {
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
  isbn_source: "auto" | "ean" | "barcode" | "upc" | "sku"
  notify_emails: string[]
  start_month: string | null
}

export type TokenSummary = { set: boolean; source: "none" | "stored" | "env"; lastFour: string | null; testMode: boolean }
export type SettingsView = { version: number | null; settings: Settings; token: TokenSummary }
export type FieldError = { field: string; code: string; message: string }

/** What a refused request said, for a toast or a field. */
export type ApiFailure = { code: string; message: string; errors?: FieldError[] }

export function failureOf(error: unknown): ApiFailure {
  const e = error as { status?: number; message?: string; code?: string; errors?: FieldError[] }
  return { code: e.code ?? "error", message: e.message ?? "Something went wrong.", errors: e.errors }
}

export type Component = { variant_id: string; quantity: number }
export type VariantRow = {
  id: string
  product_id: string
  product_title: string | null
  variant_title: string | null
  sku: string | null
  isbn: string | null
  include: boolean
  rhq_product_id: string | null
  bundle_components: Component[] | null
}
export type VariantPage = { count: number; offset: number; limit: number; variants: VariantRow[] }

export type ActionResult =
  | { ok: true; message: string; attemptId: string | null }
  | { ok: false; attemptId: string | null; problem: { code: string; title: string; detail: string | null; httpStatus: number | null } }

export type MonthLine = {
  period: string
  status: "built" | "staged" | "imported" | "rejected" | "failed" | null
  row_count: number | null
  totals: Record<string, string> | null
  pushed_at: string | null
  import_url: string | null
  hold_back_reasons: string[]
  hold_back_notes: string[]
  rhq_error_summary: string | null
  last_attempt: AttemptLine | null
  last_dry_run: AttemptLine | null
}

export type AttemptLine = {
  mode: "live" | "test" | "dry_run"
  trigger: "scheduled" | "manual"
  state: string
  finished_at: string | null
  problem_code: string | null
  problem_title: string | null
  problem_detail: string | null
  retry_at: string | null
}

export type StatusView = {
  enabled: boolean
  push_mode: "automatic" | "manual"
  connected: boolean
  /** The token changed since the last handshake. */
  connection_unconfirmed: boolean
  marketplace: string | null
  deployment: { ok: true } | { ok: false; code: string; recordedOrigin?: string; currentOrigin?: string }
  planned: { at: string; periods: string[] } | null
  months: MonthLine[]
}

export const api = {
  settings: () => sdk.client.fetch<SettingsView>(`${BASE}/settings`),
  saveSettings: (patch: Partial<Settings>) => sdk.client.fetch<SettingsView>(`${BASE}/settings`, { method: "POST", body: patch }),
  putToken: (token: string) => sdk.client.fetch<SettingsView>(`${BASE}/token`, { method: "PUT", body: { token } }),
  deleteToken: () => sdk.client.fetch<SettingsView>(`${BASE}/token`, { method: "DELETE" }),
  variants: (offset: number, limit: number) => sdk.client.fetch<VariantPage>(`${BASE}/variants`, { query: { offset, limit } }),
  saveVariant: (id: string, body: Partial<Pick<VariantRow, "include" | "rhq_product_id" | "bundle_components">>) =>
    sdk.client.fetch(`${BASE}/variants/${id}`, { method: "POST", body }),
  includeVariants: (variant_ids: string[], include: boolean) => sdk.client.fetch(`${BASE}/variants/batch`, { method: "POST", body: { variant_ids, include } }),
  status: () => sdk.client.fetch<StatusView>(`${BASE}/status`),
  push: (period: string, dryRun: boolean) => sdk.client.fetch<ActionResult>(`${BASE}/push`, { method: "POST", body: { period, dry_run: dryRun } }),
  checkImports: () => sdk.client.fetch<ActionResult>(`${BASE}/imports/check`, { method: "POST" }),
  confirmDeployment: () => sdk.client.fetch<StatusView>(`${BASE}/deployment`, { method: "POST" }),
  // The SDK hands back the raw response for anything but JSON.
  csv: (period: string) => sdk.client.fetch<Response>(`${BASE}/csv/${period}`, { headers: { accept: "text/csv" } }),
  testConnection: () => sdk.client.fetch<Record<string, unknown>>(`${BASE}/connection`, { method: "POST" }),
}
