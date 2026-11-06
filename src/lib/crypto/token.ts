// Where the RHQ token comes from, and what the admin may know about it. The
// token is write-only: no route returns it, and the admin learns only its
// source, whether it is a test key and its last four characters (enough to
// tell which token a store uses after a rotation in RHQ; RHQ tokens are 40+
// random characters, so four leave the rest unguessable).

export const TOKEN_ENV = "ROYALTIES_HQ_API_TOKEN"

/** RHQ test-mode tokens carry this prefix; they dry-run and never stage. */
export const RHQ_TEST_TOKEN_PREFIX = "rhq_test_"

// Below this length four characters would be a large share of the secret.
// Such a token is broken anyway and Test connection will say so.
const MIN_LENGTH_TO_REVEAL = 16

export type TokenSource = "env" | "stored" | "none"

export interface ResolvedToken {
  source: TokenSource
  token: string | null
}

export interface TokenSummary {
  set: boolean
  source: TokenSource
  lastFour: string | null
  testMode: boolean
}

/**
 * The environment wins: production should keep the token out of
 * the database entirely, so a copied database cannot push as the live store.
 * `stored` is only called when the environment has no token, so a broken
 * sealed value cannot stop an env-configured store from pushing.
 */
export function resolveToken(
  env: Record<string, string | undefined>,
  stored: () => string | null
): ResolvedToken {
  const fromEnv = env[TOKEN_ENV]?.trim()
  if (fromEnv) return { source: "env", token: fromEnv }
  const token = stored()
  return token ? { source: "stored", token } : { source: "none", token: null }
}

export function summariseToken(resolved: ResolvedToken): TokenSummary {
  const { token, source } = resolved
  if (!token) return { set: false, source: "none", lastFour: null, testMode: false }
  return {
    set: true,
    source,
    lastFour: token.length >= MIN_LENGTH_TO_REVEAL ? token.slice(-4) : null,
    testMode: token.startsWith(RHQ_TEST_TOKEN_PREFIX),
  }
}
