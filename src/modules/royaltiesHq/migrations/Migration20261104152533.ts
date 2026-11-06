import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261104152533 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "rhq_variant" drop constraint if exists "rhq_variant_variant_id_unique";`);
    this.addSql(`alter table if exists "rhq_state" drop constraint if exists "rhq_state_key_unique";`);
    this.addSql(`alter table if exists "rhq_snapshot" drop constraint if exists "rhq_snapshot_connection_id_period_mode_unique";`);
    this.addSql(`alter table if exists "rhq_settings" drop constraint if exists "rhq_settings_version_unique";`);
    this.addSql(`alter table if exists "rhq_secret" drop constraint if exists "rhq_secret_key_unique";`);
    this.addSql(`alter table if exists "rhq_sale_context" drop constraint if exists "rhq_sale_context_connection_id_order_id_unique";`);
    this.addSql(`create table if not exists "rhq_push_attempt" ("id" text not null, "connection_id" integer null, "period" text not null, "mode" text check ("mode" in ('live', 'test', 'dry_run')) not null, "trigger" text check ("trigger" in ('scheduled', 'manual')) not null, "state" text check ("state" in ('prepared', 'sent', 'accepted', 'rejected', 'failed', 'unknown', 'refused', 'interrupted')) not null default 'prepared', "started_at" timestamptz not null, "finished_at" timestamptz null, "http_status" integer null, "problem_code" text null, "problem_title" text null, "problem_detail" text null, "row_errors" jsonb null, "import_id" integer null, "result" text null, "content_hash" text null, "body_sha256" text null, "manifest" jsonb null, "warnings" jsonb null, "retry_at" timestamptz null, "retry_count" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "rhq_push_attempt_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rhq_push_attempt_deleted_at" ON "rhq_push_attempt" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rhq_push_attempt_period_started_at" ON "rhq_push_attempt" ("period", "started_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rhq_push_attempt_retry_at" ON "rhq_push_attempt" ("retry_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "rhq_sale_context" ("id" text not null, "connection_id" integer not null, "order_id" text not null, "context" jsonb not null, "frozen_at" timestamptz null, "frozen_reason" text check ("frozen_reason" in ('period_imported', 'refund_reported')) null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "rhq_sale_context_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rhq_sale_context_deleted_at" ON "rhq_sale_context" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rhq_sale_context_connection_id_order_id_unique" ON "rhq_sale_context" ("connection_id", "order_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "rhq_secret" ("id" text not null, "key" text not null, "sealed" text not null, "base_url" text not null, "last_four" text null, "test_mode" boolean not null default false, "set_by" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "rhq_secret_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rhq_secret_key_unique" ON "rhq_secret" ("key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rhq_secret_deleted_at" ON "rhq_secret" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "rhq_settings" ("id" text not null, "version" integer not null, "data" jsonb not null, "changed_by" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "rhq_settings_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rhq_settings_deleted_at" ON "rhq_settings" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rhq_settings_version_unique" ON "rhq_settings" ("version") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "rhq_snapshot" ("id" text not null, "connection_id" integer not null, "period" text not null, "mode" text check ("mode" in ('live', 'test')) not null default 'live', "status" text check ("status" in ('built', 'staged', 'imported', 'rejected', 'failed')) not null default 'built', "refund_cutoff_at" timestamptz not null, "content_hash" text not null, "generated_at" timestamptz not null, "row_count" integer not null, "totals" jsonb not null, "last_http_status" integer null, "error_code" text null, "attempts" integer not null default 0, "hold_back_reasons" jsonb null, "import_id" integer null, "import_url" text null, "payload_sha256" text null, "pushed_refund_ids" text[] null, "reported_money_only_refund_ids" text[] null, "applied_money_only_refund_ids" text[] null, "pushed_order_ids" text[] null, "pushed_at" timestamptz null, "rhq_error_count" integer null, "rhq_error_summary" text null, "rhq_error_reason" text null, "rhq_checked_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "rhq_snapshot_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rhq_snapshot_deleted_at" ON "rhq_snapshot" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rhq_snapshot_connection_id_period_mode_unique" ON "rhq_snapshot" ("connection_id", "period", "mode") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "rhq_state" ("id" text not null, "key" text not null, "value" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "rhq_state_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rhq_state_key_unique" ON "rhq_state" ("key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rhq_state_deleted_at" ON "rhq_state" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "rhq_variant" ("id" text not null, "variant_id" text not null, "include" boolean not null default false, "rhq_product_id" text null, "bundle_components" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "rhq_variant_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rhq_variant_variant_id_unique" ON "rhq_variant" ("variant_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rhq_variant_deleted_at" ON "rhq_variant" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "rhq_push_attempt" cascade;`);

    this.addSql(`drop table if exists "rhq_sale_context" cascade;`);

    this.addSql(`drop table if exists "rhq_secret" cascade;`);

    this.addSql(`drop table if exists "rhq_settings" cascade;`);

    this.addSql(`drop table if exists "rhq_snapshot" cascade;`);

    this.addSql(`drop table if exists "rhq_state" cascade;`);

    this.addSql(`drop table if exists "rhq_variant" cascade;`);
  }

}
