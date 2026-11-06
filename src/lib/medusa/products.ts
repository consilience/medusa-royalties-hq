import type { ProductConfig } from "../../core/types"
import { pickIsbnSource, type IsbnSource } from "../../core/identity"
import { toMinor } from "./money"

/** Every field productConfigs reads, and nothing else. */
export const VARIANT_FIELDS: string[] = [
  "id",
  "title",
  "sku",
  "ean",
  "upc",
  "barcode",
  "product.title",
  "prices.currency_code",
  "prices.raw_amount",
  "prices.price_list_id",
  "prices.rules_count",
  "prices.min_quantity",
  "prices.max_quantity",
]

export type Component = { variant_id: string; quantity: number }
export type VariantRow = { variant_id: string; include: boolean; rhq_product_id: string | null; bundle_components: Component[] | null }

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null)

/**
 * The variant's own price in a currency: the price set's base price, with no
 * price list, no rules (region, customer group) and no quantity tier.
 * price_ratio splits a bundle by these, so a sale price would skew the split.
 * A tier carries no rules (it is min/max_quantity), so it must be excluded
 * on its own; query.graph returns prices in no promised order.
 */
function regularPrice(prices: any[] | undefined, currency: string) {
  const base = (prices ?? []).find(
    (p) =>
      String(p.currency_code).toUpperCase() === currency &&
      !p.price_list_id &&
      !(p.rules_count > 0) &&
      !(p.min_quantity > 1) &&
      p.max_quantity == null,
  )
  return base ? toMinor(base.raw_amount, currency) : null
}

/**
 * The core's product inputs for one currency, keyed by variant id. A variant
 * with no rhq_variant row is excluded (opt-in only).
 */
export function productConfigs(
  variants: readonly any[],
  rows: readonly VariantRow[],
  { currency, isbnSource }: { currency: string; isbnSource: IsbnSource },
): Map<string, ProductConfig> {
  const byVariant = new Map(rows.map((r) => [r.variant_id, r]))
  const cur = currency.toUpperCase()
  const out = new Map<string, ProductConfig>()
  for (const v of variants) {
    const row = byVariant.get(v.id)
    const candidates = { ean: text(v.ean), barcode: text(v.barcode), upc: text(v.upc), sku: text(v.sku) }
    const title = [text(v.product?.title), text(v.title)].filter(Boolean).join(" - ")
    out.set(v.id, {
      variantId: v.id,
      included: row?.include === true,
      rhqProductId: text(row?.rhq_product_id),
      isbnSourceValue: pickIsbnSource(candidates, isbnSource),
      sku: candidates.sku,
      asin: null,
      title,
      regularUnitPrice: regularPrice(v.prices, cur),
      bundleComponents: row?.bundle_components?.length
        ? row.bundle_components.map((c) => ({ variantId: c.variant_id, quantity: c.quantity }))
        : null,
    })
  }
  return out
}

/**
 * Problems with a manual composition, checked when it is saved so the row
 * builder never meets one. `others` holds every other variant's saved
 * composition, to find cycles that run through them.
 */
export function compositionErrors(
  variantId: string,
  components: readonly Component[],
  known: ReadonlySet<string>,
  others: ReadonlyMap<string, readonly Component[]>,
): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  const reaches = (from: string, visited: Set<string>): boolean => {
    if (from === variantId) return true
    if (visited.has(from)) return false
    visited.add(from)
    return (others.get(from) ?? []).some((c) => reaches(c.variant_id, visited))
  }
  for (const c of components) {
    if (seen.has(c.variant_id)) {
      errors.push(`duplicate:${c.variant_id}`)
      continue
    }
    seen.add(c.variant_id)
    if (!known.has(c.variant_id)) errors.push(`component_missing:${c.variant_id}`)
    else if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > 999) errors.push(`quantity_invalid:${c.variant_id}`)
    else if (reaches(c.variant_id, new Set())) errors.push(`cycle:${c.variant_id}`)
  }
  return errors
}
