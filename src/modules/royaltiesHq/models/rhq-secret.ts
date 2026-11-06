import { model } from "@medusajs/framework/utils"

// The RHQ token pasted into the admin, sealed (src/lib/crypto/seal.ts). The
// base URL it was sealed for is kept beside it because the seal binds the
// two: a token is only ever opened for that destination. last_four and
// test_mode are what the admin may show; the token itself never leaves.
const RhqSecret = model.define("rhq_secret", {
  id: model.id({ prefix: "rhqsec" }).primaryKey(),
  key: model.text().unique(),
  sealed: model.text(),
  base_url: model.text(),
  last_four: model.text().nullable(),
  test_mode: model.boolean().default(false),
  set_by: model.text().nullable(),
})

export default RhqSecret
