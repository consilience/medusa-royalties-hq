import { DecryptionError, loadKeyRing, openToken, sealToken } from "../crypto/seal"
import { resolveToken, summariseToken, RHQ_TEST_TOKEN_PREFIX, TOKEN_ENV, type TokenSummary } from "../crypto/token"
import { DEFAULT_SETTINGS, validateSettingsChange, type SettingsFieldError, type StoredSettings } from "../settings/settings"

/** The module service methods these read and write through. */
export type SettingsStore = {
  currentSettingsVersion(): Promise<{ version: number; data: Record<string, unknown> } | null>
  appendSettingsVersion(data: Record<string, unknown>, changedBy: string | null): Promise<{ version: number; data: Record<string, unknown> }>
  listRhqSecrets(filters: { key: string }): Promise<any[]>
  createRhqSecrets(data: Record<string, unknown>): Promise<any>
  deleteRhqSecrets(id: string | string[]): Promise<void>
}

type Env = Record<string, string | undefined>
export const TOKEN_KEY = "api_token"
const MIN_LENGTH_TO_REVEAL = 16
// RHQ tokens: rhq_live_… or rhq_test_…, then the secret.
const RHQ_TOKEN = /^rhq_(live|test)_[A-Za-z0-9_-]{16,}$/

export class AdminError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export type SettingsView = { version: number | null; settings: StoredSettings; token: TokenSummary }

/**
 * The stored token is summarised from what was recorded when it was set,
 * never by opening it: showing the settings page must not need the key, and
 * must not put the token in memory for nothing.
 */
async function tokenSummary(store: SettingsStore, env: Env): Promise<TokenSummary> {
  if (env[TOKEN_ENV]?.trim()) return summariseToken(resolveToken(env, () => null))
  const [secret] = await store.listRhqSecrets({ key: TOKEN_KEY })
  if (!secret) return { set: false, source: "none", lastFour: null, testMode: false }
  return { set: true, source: "stored", lastFour: secret.last_four ?? null, testMode: secret.test_mode === true }
}

async function current(store: SettingsStore): Promise<{ version: number | null; settings: StoredSettings }> {
  const row = await store.currentSettingsVersion()
  return { version: row?.version ?? null, settings: { ...DEFAULT_SETTINGS, ...(row?.data as Partial<StoredSettings>) } }
}

export async function readSettings(store: SettingsStore, env: Env): Promise<SettingsView> {
  return { ...(await current(store)), token: await tokenSummary(store, env) }
}

// Only the known settings keys are taken from a request; anything else (a
// token pasted into the wrong form, say) is dropped, never stored.
function pick(patch: Record<string, unknown>): Partial<StoredSettings> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (key in patch) out[key] = patch[key]
  return out as Partial<StoredSettings>
}

export async function saveSettings(
  store: SettingsStore,
  patch: Record<string, unknown>,
  changedBy: string | null,
  env: Env,
): Promise<SettingsView | { errors: SettingsFieldError[] }> {
  const { settings } = await current(store)
  const next = { ...settings, ...pick(patch) }
  const token = await tokenSummary(store, env)
  const errors = validateSettingsChange(next, { tokenSet: token.set, env })
  if (errors.length) return { errors }
  const row = await store.appendSettingsVersion(next, changedBy)
  return { version: row.version, settings: next, token }
}

export async function putToken(store: SettingsStore, token: unknown, setBy: string | null, env: Env): Promise<SettingsView> {
  if (env[TOKEN_ENV]?.trim()) {
    throw new AdminError(409, "token_from_env", `The token is set by ${TOKEN_ENV} on the server; change it there.`)
  }
  if (typeof token !== "string" || !RHQ_TOKEN.test(token.trim())) {
    throw new AdminError(400, "token_invalid", "Paste the token Royalties HQ showed you; it starts rhq_live_ or rhq_test_.")
  }
  const keys = loadKeyRing(env)
  if (!keys) {
    throw new AdminError(409, "encryption_key_missing", "Set ROYALTIES_HQ_ENCRYPTION_KEY on the server before storing a token.")
  }
  const { settings } = await current(store)
  if (!settings.base_url) throw new AdminError(409, "base_url_required", "Save the API base URL first: the token is sealed for it.")
  const value = token.trim()
  // Replace whole: a token is never merged with the one before it.
  for (const old of await store.listRhqSecrets({ key: TOKEN_KEY })) await store.deleteRhqSecrets(old.id)
  await store.createRhqSecrets({
    key: TOKEN_KEY,
    sealed: sealToken(value, settings.base_url, keys),
    base_url: settings.base_url,
    last_four: value.length >= MIN_LENGTH_TO_REVEAL ? value.slice(-4) : null,
    test_mode: value.startsWith(RHQ_TEST_TOKEN_PREFIX),
    set_by: setBy,
  })
  return readSettings(store, env)
}

export async function deleteToken(store: SettingsStore, changedBy: string | null, env: Env): Promise<SettingsView> {
  for (const old of await store.listRhqSecrets({ key: TOKEN_KEY })) await store.deleteRhqSecrets(old.id)
  // An enabled store with no token cannot push; say so in the settings
  // rather than fail at the next scheduled run. An env token still counts.
  const { settings } = await current(store)
  if (settings.enabled && !(await tokenSummary(store, env)).set) {
    await store.appendSettingsVersion({ ...settings, enabled: false }, changedBy)
  }
  return readSettings(store, env)
}

/**
 * Where to send and with what: the saved base URL and the token, from the
 * environment or opened from its seal. The seal is bound to the URL it was
 * stored for, so after the URL changes the stored token will not open, and
 * it is never sent to the new destination.
 */
export async function resolveEndpoint(store: SettingsStore, env: Env): Promise<{ baseUrl: string; token: string }> {
  const { settings } = await current(store)
  const baseUrl = settings.base_url
  const fromEnv = env[TOKEN_ENV]?.trim()
  if (baseUrl && fromEnv) return { baseUrl, token: fromEnv }
  const [secret] = await store.listRhqSecrets({ key: TOKEN_KEY })
  if (!baseUrl || !secret) {
    throw new AdminError(409, "not_configured", "Save the API base URL and a token first.")
  }
  const keys = loadKeyRing(env)
  if (!keys) throw new AdminError(409, "encryption_key_missing", "ROYALTIES_HQ_ENCRYPTION_KEY is not set on the server.")
  if (secret.base_url !== baseUrl) {
    throw new AdminError(409, "token_rebind_required", "The base URL changed since the token was saved. Paste the token again.")
  }
  try {
    return { baseUrl, token: openToken(secret.sealed, baseUrl, keys) }
  } catch (e) {
    if (!(e instanceof DecryptionError)) throw e
    throw new AdminError(409, "token_unreadable", "The stored token cannot be opened with this server's key. Paste it again.")
  }
}
