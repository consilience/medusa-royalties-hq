import { model } from "@medusajs/framework/utils"

// What a sale was built with (inclusion, bundle split, regular prices),
// recorded when a live push of its month is accepted, so a later refund
// mirrors the sale that was sent even after products or settings change.
// Frozen once the month is imported or a refund of the order has gone out.
//
// Keyed by RHQ connection as well as order, like rhq_snapshot: a connection
// that never received a sale must not inherit how another one was sent it.
const RhqSaleContext = model
  .define("rhq_sale_context", {
    id: model.id({ prefix: "rhqsale" }).primaryKey(),
    connection_id: model.number(),
    order_id: model.text(),
    context: model.json(),
    frozen_at: model.dateTime().nullable(),
    frozen_reason: model.enum(["period_imported", "refund_reported"]).nullable(),
  })
  .indexes([{ on: ["connection_id", "order_id"], unique: true }])

export default RhqSaleContext
