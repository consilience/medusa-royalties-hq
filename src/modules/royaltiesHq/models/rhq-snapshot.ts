import { model } from "@medusajs/framework/utils"

// What the store knows about each month it has pushed. Keyed by the RHQ connection id from the
// handshake as well as the period, so pointing the plugin at another
// connection starts a fresh history rather than inheriting cut-offs and
// "already pushed" manifests that belong to the old one.
//
// The id lists are arrays, not JSON: Medusa merges JSON objects on update,
// and a manifest must be replaced whole.
const RhqSnapshot = model
  .define("rhq_snapshot", {
    id: model.id({ prefix: "rhqsnap" }).primaryKey(),
    connection_id: model.number(),
    period: model.text(),
    mode: model.enum(["live", "test"]).default("live"),
    status: model.enum(["built", "staged", "imported", "rejected", "failed"]).default("built"),
    // The cut-off this month was built with; a re-push must reuse it.
    refund_cutoff_at: model.dateTime(),
    // SHA-256 of the canonical payload without generated_at.
    content_hash: model.text(),
    // Reused on an identical re-push so the bytes match.
    generated_at: model.dateTime(),
    row_count: model.number(),
    // { "GBP": "123.45" }, decimal strings.
    totals: model.json(),
    last_http_status: model.number().nullable(),
    error_code: model.text().nullable(),
    attempts: model.number().default(0),
    hold_back_reasons: model.json().nullable(),
    import_id: model.number().nullable(),
    import_url: model.text().nullable(),
    // RHQ's receipt of the body it took.
    payload_sha256: model.text().nullable(),
    pushed_refund_ids: model.array().nullable(),
    reported_money_only_refund_ids: model.array().nullable(),
    applied_money_only_refund_ids: model.array().nullable(),
    pushed_order_ids: model.array().nullable(),
    pushed_at: model.dateTime().nullable(),
    rhq_error_count: model.number().nullable(),
    rhq_error_summary: model.text().nullable(),
    rhq_error_reason: model.text().nullable(),
    rhq_checked_at: model.dateTime().nullable(),
  })
  .indexes([{ on: ["connection_id", "period", "mode"], unique: true }])

export default RhqSnapshot
