import { model } from "@medusajs/framework/utils"

// Small facts the plugin keeps between runs: the recorded deployment origin,
// the last handshake, the cached connection id.
const RhqState = model.define("rhq_state", {
  id: model.id({ prefix: "rhqst" }).primaryKey(),
  key: model.text().unique(),
  value: model.json().nullable(),
})

export default RhqState
