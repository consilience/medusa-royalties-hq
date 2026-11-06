import { pickIsbnSource, type IsbnSource } from "../../core/identity"
import { compositionErrors, type Component } from "../medusa/products"
import type { Query } from "../medusa/orders"
import { AdminError } from "./settings"

export type VariantStore = {
  listRhqVariants(filters: Record<string, unknown>): Promise<any[]>
  createRhqVariants(data: Record<string, unknown>): Promise<any>
  updateRhqVariants(data: Record<string, unknown>): Promise<any>
}

// Identifiers and titles only: the list never needs prices or inventory.
const LIST_FIELDS = ["id", "title", "sku", "ean", "upc", "barcode", "product_id", "product.title"]
const MAX_PAGE = 200

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null)

export async function listVariants(
  query: Query,
  store: VariantStore,
  { offset = 0, limit = 50, isbnSource = "auto" }: { offset?: number; limit?: number; isbnSource?: IsbnSource },
) {
  const take = Math.min(Math.max(1, limit), MAX_PAGE)
  const { data, metadata } = await query.graph({
    entity: "product_variant",
    fields: LIST_FIELDS,
    pagination: { skip: Math.max(0, offset), take, order: { id: "ASC" } },
  })
  const rows = data.length ? await store.listRhqVariants({ variant_id: data.map((v) => v.id) }) : []
  const byVariant = new Map(rows.map((r) => [r.variant_id, r]))
  return {
    count: metadata?.count ?? data.length,
    offset,
    limit: take,
    variants: data.map((v) => {
      const row = byVariant.get(v.id)
      return {
        id: v.id,
        product_id: v.product_id,
        product_title: v.product?.title ?? null,
        variant_title: v.title,
        sku: text(v.sku),
        isbn: pickIsbnSource({ ean: text(v.ean), barcode: text(v.barcode), upc: text(v.upc), sku: text(v.sku) }, isbnSource),
        include: row?.include === true,
        rhq_product_id: row?.rhq_product_id ?? null,
        bundle_components: row?.bundle_components ?? null,
      }
    }),
  }
}

async function existingIds(query: Query, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id"],
    filters: { id: ids },
    pagination: { skip: 0, take: ids.length },
  })
  return new Set(data.map((v) => v.id))
}

async function upsert(store: VariantStore, variantId: string, data: Record<string, unknown>) {
  const [row] = await store.listRhqVariants({ variant_id: variantId })
  return row ? store.updateRhqVariants({ id: row.id, ...data }) : store.createRhqVariants({ variant_id: variantId, ...data })
}

export async function saveVariant(query: Query, store: VariantStore, variantId: string, body: Record<string, unknown>) {
  const components = Array.isArray(body.bundle_components) ? (body.bundle_components as Component[]) : null
  const known = await existingIds(query, [variantId, ...(components ?? []).map((c) => c?.variant_id).filter((id): id is string => typeof id === "string")])
  if (!known.has(variantId)) throw new AdminError(404, "variant_not_found", "No such variant.")
  const data: Record<string, unknown> = {}
  if ("include" in body) data.include = body.include === true
  if ("rhq_product_id" in body) data.rhq_product_id = text(body.rhq_product_id)
  if ("bundle_components" in body) {
    if (components?.length) {
      const others = new Map(
        (await store.listRhqVariants({})).filter((r) => r.variant_id !== variantId && r.bundle_components).map((r) => [r.variant_id, r.bundle_components]),
      )
      const errors = compositionErrors(variantId, components, known, others)
      if (errors.length) return { errors }
      data.bundle_components = components.map((c) => ({ variant_id: c.variant_id, quantity: c.quantity }))
    } else data.bundle_components = null
  }
  const row = await upsert(store, variantId, data)
  return { variant: { id: variantId, include: row.include, rhq_product_id: row.rhq_product_id, bundle_components: row.bundle_components } }
}

export async function includeVariants(query: Query, store: VariantStore, variantIds: unknown, include: unknown) {
  const ids = Array.isArray(variantIds) ? [...new Set(variantIds.filter((id): id is string => typeof id === "string"))] : []
  if (!ids.length || ids.length > MAX_PAGE) throw new AdminError(400, "variant_ids_invalid", `Send 1 to ${MAX_PAGE} variant ids.`)
  const known = await existingIds(query, ids)
  const missing = ids.filter((id) => !known.has(id))
  if (missing.length) throw new AdminError(404, "variant_not_found", `No such variants: ${missing.join(", ")}`)
  for (const id of ids) await upsert(store, id, { include: include === true })
  return { updated: ids.length }
}
