import { model } from "@medusajs/framework/utils"

// Per-variant Royalties HQ config, in our own table rather than variant
// metadata: Medusa's store routes return metadata to shoppers.
const RhqVariant = model.define("rhq_variant", {
  id: model.id({ prefix: "rhqvar" }).primaryKey(),
  variant_id: model.text().unique(),
  include: model.boolean().default(false),
  rhq_product_id: model.text().nullable(),
  // [{ variant_id, quantity }] for a manually composed bundle.
  bundle_components: model.json().nullable(),
})

export default RhqVariant
