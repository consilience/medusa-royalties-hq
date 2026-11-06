import { model } from "@medusajs/framework/utils"

// One row per try, scheduled or by a person. `state` is written before the PUT goes out
// (prepared), so a crash between RHQ accepting and this store recording it
// leaves a row the next run can reconcile against RHQ's payload_sha256.
const RhqPushAttempt = model
  .define("rhq_push_attempt", {
    id: model.id({ prefix: "rhqatt" }).primaryKey(),
    connection_id: model.number().nullable(),
    period: model.text(),
    mode: model.enum(["live", "test", "dry_run"]),
    trigger: model.enum(["scheduled", "manual"]),
    state: model
      .enum(["prepared", "sent", "accepted", "rejected", "failed", "unknown", "refused", "interrupted"])
      .default("prepared"),
    started_at: model.dateTime(),
    finished_at: model.dateTime().nullable(),
    http_status: model.number().nullable(),
    problem_code: model.text().nullable(),
    problem_title: model.text().nullable(),
    problem_detail: model.text().nullable(),
    row_errors: model.json().nullable(),
    import_id: model.number().nullable(),
    result: model.text().nullable(),
    content_hash: model.text().nullable(),
    // SHA-256 of the exact bytes sent, to match RHQ's payload_sha256.
    body_sha256: model.text().nullable(),
    // The manifest the snapshot will record if RHQ accepts this body.
    manifest: model.json().nullable(),
    warnings: model.json().nullable(),
    retry_at: model.dateTime().nullable(),
    retry_count: model.number().default(0),
  })
  .indexes([{ on: ["period", "started_at"] }, { on: ["retry_at"] }])

export default RhqPushAttempt
