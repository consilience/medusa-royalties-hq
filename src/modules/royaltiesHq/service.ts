import { LockMode } from "@medusajs/framework/mikro-orm/core"
import type { EntityManager } from "@medusajs/framework/mikro-orm/knex"
import type { Context } from "@medusajs/framework/types"
import { generateEntityId, InjectManager, InjectTransactionManager, MedusaContext, MedusaService } from "@medusajs/framework/utils"
import { MODELS } from "./models"

/** The tables `patchRows` writes; the names are the MikroORM entity names. */
export type PatchableEntity = "RhqSnapshot" | "RhqPushAttempt" | "RhqSaleContext"

export type SettingsVersion = {
  id: string
  version: number
  data: Record<string, unknown>
  changed_by: string | null
  created_at: Date
}

// CRUD only (the generated methods), plus a few reads and writes that every
// caller would otherwise repeat. Business rules live in src/lib and the
// workflows.
/** The plugin's options, as a store passes them in medusa-config. */
export type RoyaltiesHqOptions = { backendUrl?: string }

class RoyaltiesHqModuleService extends MedusaService(MODELS) {
  protected readonly options_: RoyaltiesHqOptions

  // Plugin options reach only the plugin's modules, so routes, jobs and
  // subscribers read them through this service.
  constructor(container: Record<string, unknown>, options: RoyaltiesHqOptions = {}) {
    // eslint-disable-next-line prefer-rest-params
    super(...(arguments as unknown as [Record<string, unknown>]))
    this.options_ = options ?? {}
  }

  get pluginOptions(): RoyaltiesHqOptions {
    return this.options_
  }

  async currentSettingsVersion(): Promise<SettingsVersion | null> {
    const [row] = await this.listRhqSettings({}, { order: { version: "DESC" }, take: 1 })
    return (row as SettingsVersion | undefined) ?? null
  }

  /**
   * Appends the next version. Two saves racing for one version number lose
   * one to the unique index rather than silently sharing it; the admin
   * retries.
   */
  async appendSettingsVersion(data: Record<string, unknown>, changedBy: string | null): Promise<SettingsVersion> {
    const current = await this.currentSettingsVersion()
    const row = await this.createRhqSettings({
      version: (current?.version ?? 0) + 1,
      data,
      changed_by: changedBy,
    })
    return row as SettingsVersion
  }

  async readState<T = unknown>(key: string): Promise<T | null> {
    const [row] = await this.listRhqStates({ key })
    return (row?.value as T | undefined) ?? null
  }

  /**
   * One statement, so the key is never missing between a delete and a
   * create, and two writers racing both succeed (the later wins) rather
   * than one hitting the unique index. The generated update would merge
   * JSON, and the value must be replaced whole.
   */
  @InjectManager()
  async writeState(key: string, value: unknown, @MedusaContext() sharedContext: Context = {}): Promise<void> {
    const em = sharedContext.manager as EntityManager
    await em.execute(
      `insert into rhq_state (id, key, value, created_at, updated_at)
       values (?, ?, cast(? as jsonb), now(), now())
       on conflict (key) where deleted_at is null do update
         set value = excluded.value, updated_at = now()`,
      [generateEntityId(undefined, "rhqst"), key, JSON.stringify(value ?? null)],
    )
  }

  /**
   * Runs `work` in one database transaction. Pass the context it is given to
   * every service call inside, reads included: a call without it runs on its
   * own connection, outside the transaction, and neither sees the group's
   * writes nor rolls back with them.
   */
  @InjectTransactionManager()
  async transaction<T>(work: (sharedContext: Context) => Promise<T>, @MedusaContext() sharedContext: Context = {}): Promise<T> {
    return await work(sharedContext)
  }

  /**
   * Writes `patch` over every row matching `where` and returns how many there
   * were. Unlike the generated update*, a JSON field is replaced whole: those
   * assign with mergeObjectProperties, so `{USD}` written over `{GBP}` would
   * keep GBP, and a manifest or sale context would keep keys it no longer
   * has. The rows are locked while they are read, so `where` is also a guard
   * no concurrent writer can slip past between the read and the write.
   * `increment` adds to number columns in the same write.
   */
  @InjectTransactionManager()
  async patchRows(
    entity: PatchableEntity,
    where: Record<string, unknown>,
    patch: Record<string, unknown>,
    increment: Record<string, number> = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<number> {
    const em = sharedContext.transactionManager as EntityManager
    // Rows created earlier in the transaction are only persisted, not yet
    // written; flush so the locking read below can see them.
    await em.flush()
    const rows = await em.find<any>(entity, where, { lockMode: LockMode.PESSIMISTIC_WRITE })
    const values = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    for (const row of rows) {
      em.assign(row, values, { mergeObjectProperties: false })
      for (const [field, by] of Object.entries(increment)) row[field] += by
    }
    await em.flush()
    return rows.length
  }

  /**
   * Sets a state key to the ISO time `at` unless it already holds a time
   * later than `notAfter`, in one statement, and returns whether it wrote.
   * One statement because two claims racing must not both read the old
   * value and both win: the loser of the insert waits on the winner's row
   * and then sees its new time.
   */
  @InjectManager()
  async claimStateTime(key: string, at: Date, notAfter: Date, @MedusaContext() sharedContext: Context = {}): Promise<boolean> {
    const em = sharedContext.manager as EntityManager
    const rows = await em.execute(
      `insert into rhq_state (id, key, value, created_at, updated_at)
       values (?, ?, to_jsonb(cast(? as text)), now(), now())
       on conflict (key) where deleted_at is null do update
         set value = excluded.value, updated_at = now()
         where cast(rhq_state.value #>> '{}' as timestamptz) <= cast(? as timestamptz)
       returning id`,
      [generateEntityId(undefined, "rhqst"), key, at.toISOString(), notAfter.toISOString()],
    )
    return rows.length > 0
  }
}

export default RoyaltiesHqModuleService
