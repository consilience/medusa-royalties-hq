import { productConfigs, compositionErrors } from "../products"

const variant = (over: any = {}) => ({
  id: "variant_1",
  title: "Hardback",
  sku: "9780306406157",
  ean: null,
  upc: null,
  barcode: null,
  product: { title: "A Book" },
  prices: [
    { currency_code: "gbp", raw_amount: { value: "12.99", precision: 20 }, price_list_id: null, rules_count: 0 },
    { currency_code: "gbp", raw_amount: { value: "9.99", precision: 20 }, price_list_id: "plist_sale", rules_count: 0 },
    { currency_code: "gbp", raw_amount: { value: "11", precision: 20 }, price_list_id: null, rules_count: 1 },
    { currency_code: "usd", raw_amount: { value: "15", precision: 20 }, price_list_id: null, rules_count: 0 },
  ],
  ...over,
})

describe("productConfigs", () => {
  it("is excluded unless the variant is opted in", () => {
    const c = productConfigs([variant()], [], { currency: "GBP", isbnSource: "auto" }).get("variant_1")!
    expect(c.included).toBe(false)
  })

  it("reads opt-in, override and composition from rhq_variant", () => {
    const c = productConfigs(
      [variant()],
      [{ variant_id: "variant_1", include: true, rhq_product_id: "RHQ-9", bundle_components: [{ variant_id: "variant_2", quantity: 2 }] }],
      { currency: "GBP", isbnSource: "auto" },
    ).get("variant_1")!
    expect(c).toMatchObject({
      variantId: "variant_1",
      included: true,
      rhqProductId: "RHQ-9",
      bundleComponents: [{ variantId: "variant_2", quantity: 2 }],
    })
  })

  it("takes the regular price in the order's currency: no price list, no rules", () => {
    const configs = (cur: string) => productConfigs([variant()], [], { currency: cur, isbnSource: "auto" }).get("variant_1")!
    expect(configs("GBP").regularUnitPrice).toBe(1299n)
    expect(configs("USD").regularUnitPrice).toBe(1500n)
    expect(configs("EUR").regularUnitPrice).toBeNull()
  })

  it("picks the ISBN by the configured source, and titles by product and variant", () => {
    const c = productConfigs([variant({ ean: "9780306406157", sku: "BOOK-HB" })], [], { currency: "GBP", isbnSource: "auto" }).get("variant_1")!
    expect(c).toMatchObject({ isbnSourceValue: "9780306406157", sku: "BOOK-HB", asin: null, title: "A Book - Hardback" })
    const pinned = productConfigs([variant({ ean: "9780306406157", sku: "BOOK-HB" })], [], { currency: "GBP", isbnSource: "sku" }).get("variant_1")!
    expect(pinned.isbnSourceValue).toBe("BOOK-HB")
  })
})

describe("compositionErrors", () => {
  const known = new Set(["v_set", "v_a", "v_b"])
  it("accepts components that exist, with quantities 1 to 999", () => {
    expect(compositionErrors("v_set", [{ variant_id: "v_a", quantity: 1 }, { variant_id: "v_b", quantity: 999 }], known, new Map())).toEqual([])
  })
  it("refuses a missing component, a bad quantity and the variant itself", () => {
    expect(
      compositionErrors("v_set", [{ variant_id: "v_x", quantity: 1 }, { variant_id: "v_a", quantity: 0 }, { variant_id: "v_b", quantity: 1.5 }, { variant_id: "v_set", quantity: 1 }], known, new Map()),
    ).toEqual(["component_missing:v_x", "quantity_invalid:v_a", "quantity_invalid:v_b", "cycle:v_set"])
  })
  it("refuses a cycle through another bundle", () => {
    const others = new Map([["v_a", [{ variant_id: "v_b", quantity: 1 }]], ["v_b", [{ variant_id: "v_set", quantity: 1 }]]])
    expect(compositionErrors("v_set", [{ variant_id: "v_a", quantity: 1 }], known, others)).toEqual(["cycle:v_a"])
  })
  it("refuses the same component twice", () => {
    expect(compositionErrors("v_set", [{ variant_id: "v_a", quantity: 1 }, { variant_id: "v_a", quantity: 2 }], known, new Map())).toEqual(["duplicate:v_a"])
  })
})

describe("productConfigs on a real Medusa 2.22.3 variant", () => {
  // variant-prices.json: query.graph over product_variant with VARIANT_FIELDS,
  // after adding a region-rule price (9) and a 10+ quantity tier (8) to a
  // variant whose base EUR price is 10. Price-list prices never appear here.
  const real = require("../../../../tests/fixtures/medusa/variant-prices.json")
  const eur = (v: any) => productConfigs([v], [], { currency: "EUR", isbnSource: "auto" }).get(v.id)!.regularUnitPrice

  it("takes the base price, not the region-rule price or the quantity tier", () => {
    expect(eur(real)).toBe(1000n)
    expect(eur({ ...real, prices: [...real.prices].reverse() })).toBe(1000n)
  })
})
