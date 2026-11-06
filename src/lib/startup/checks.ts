// What the plugin checks when Medusa starts, so a deployment that cannot push
// safely says so in its log at once, not on the 15th.

export type LockingCheck = {
  provider: "in-memory" | "redis" | "postgres" | "other"
  postgresConfigured: boolean
  supported: boolean
}

export type StartupMessage = { level: "error" | "warn" | "info"; text: string }

type ProviderConfig = { resolve?: unknown; id?: unknown; is_default?: unknown }
type Env = Record<string, string | undefined>

const kindOf = (resolve: unknown): LockingCheck["provider"] => {
  const r = typeof resolve === "string" ? resolve : ""
  if (/locking-postgres/.test(r)) return "postgres"
  if (/locking-redis/.test(r)) return "redis"
  return "other"
}

export function detectLocking(configModule: unknown): LockingCheck {
  const modules = (configModule as { modules?: Record<string, unknown> } | undefined)?.modules ?? {}
  const locking = (modules as Record<string, { options?: { providers?: ProviderConfig[] } } | boolean | undefined>)
    .locking
  const providers = (typeof locking === "object" && locking?.options?.providers) || []
  const postgresConfigured = providers.some((p) => kindOf(p?.resolve) === "postgres")
  // As the Locking Module's own loader picks: the is_default provider, or the
  // only one; otherwise its built-in in-memory provider.
  const chosen =
    providers.find((p) => p?.is_default === true) ?? (providers.length === 1 ? providers[0] : undefined)
  const provider = chosen ? kindOf(chosen.resolve) : "in-memory"
  // The Postgres provider never reclaims an expired lock with no owner, and
  // its insert race lets two holders through: two pushes of one month at once would be possible.
  return { provider, postgresConfigured, supported: provider !== "postgres" }
}

export function startupMessages(configModule: unknown, env: Env): StartupMessage[] {
  const messages: StartupMessage[] = []
  const locking = detectLocking(configModule)
  const split = env.MEDUSA_WORKER_MODE === "server" || env.MEDUSA_WORKER_MODE === "worker"

  if (locking.provider === "postgres") {
    messages.push({
      level: "error",
      text:
        "Royalties HQ: the Postgres locking provider is the default, and it is unsupported: it can let two pushes of one month through. Use @medusajs/medusa/locking-redis.",
    })
  } else if (locking.provider === "in-memory" && split) {
    // The in-memory provider locks within one process only, and the push
    // job runs in the worker while Push now runs in the server.
    messages.push({
      level: "error",
      text:
        "Royalties HQ: locking is in-memory, but the server and worker run as separate processes, so a scheduled push and a Push now could send the same month at once. Configure @medusajs/medusa/locking-redis.",
    })
  } else {
    messages.push({ level: "info", text: `Royalties HQ: locking with the ${locking.provider} provider.` })
  }

  const envToken = Boolean(env.ROYALTIES_HQ_API_TOKEN?.trim())
  const key = Boolean(env.ROYALTIES_HQ_ENCRYPTION_KEY?.trim())
  if (!envToken && !key) {
    messages.push({
      level: "warn",
      text:
        "Royalties HQ: no token can be set. Set ROYALTIES_HQ_API_TOKEN, or ROYALTIES_HQ_ENCRYPTION_KEY (openssl rand -base64 32) to enter one in the admin.",
    })
  }
  return messages
}
