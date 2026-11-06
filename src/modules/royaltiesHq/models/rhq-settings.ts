import { model } from "@medusajs/framework/utils"

// One immutable row per saved change: a refund is built with the
// settings in force on its own date, and every snapshot records what it was
// built with, so old versions are never edited or deleted. `data` holds the
// validated settings object; its shape is owned by src/lib/settings.
const RhqSettings = model
  .define("rhq_settings", {
    id: model.id({ prefix: "rhqset" }).primaryKey(),
    version: model.number(),
    data: model.json(),
    changed_by: model.text().nullable(),
  })
  .indexes([{ on: ["version"], unique: true }])

export default RhqSettings
