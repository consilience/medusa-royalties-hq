import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

// The RHQ token pasted into the admin is stored sealed, so a database dump or
// a backup on its own never yields a usable token. The key lives
// only in the environment.
//
// AES-256-GCM authenticates as well as encrypts: a flipped byte fails loudly
// instead of producing a wrong token that is then sent to RHQ. The base URL
// the token was entered for is bound in as additional authenticated data, so
// a token can only ever be opened for that destination: editing the base URL
// in the database cannot redirect a saved credential to another host.

const ALGORITHM = "aes-256-gcm"
const KEY_BYTES = 32
// 96 bits is GCM's native nonce size; other sizes are hashed into one and
// lose the random-IV collision bound.
const IV_BYTES = 12
const TAG_BYTES = 16
const VERSION = "v1"

export const KEY_ENV = "ROYALTIES_HQ_ENCRYPTION_KEY"
export const PREVIOUS_KEY_ENV = "ROYALTIES_HQ_ENCRYPTION_KEY_PREVIOUS"

export class EncryptionKeyError extends Error {
  name = "EncryptionKeyError"
}

// Messages name the failure but never the plaintext or the envelope, so a
// logged exception cannot leak what it was protecting.
export class DecryptionError extends Error {
  name = "DecryptionError"
}

export interface KeyRing {
  /** Seals every new value. */
  current: Buffer
  /** Accepted for opening only, so a key can be rotated without a flag day. */
  previous: Buffer | null
}

type Env = Record<string, string | undefined>

function decodeKey(name: string, value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64")
  // Buffer.from(…, "base64") never throws; it skips junk silently, so the
  // length is what catches a truncated, hex or mis-pasted key.
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `${name} must be 32 bytes, base64-encoded (generate one with: openssl rand -base64 32).`
    )
  }
  return key
}

/**
 * The key ring, or null when no key is set. Null is not an error: the store
 * may supply the token through ROYALTIES_HQ_API_TOKEN instead, and the admin
 * then disables token entry with an explanation.
 */
export function loadKeyRing(env: Env = process.env): KeyRing | null {
  const current = env[KEY_ENV]
  if (!current || current.trim() === "") return null
  const previous = env[PREVIOUS_KEY_ENV]
  return {
    current: decodeKey(KEY_ENV, current),
    previous: previous && previous.trim() !== "" ? decodeKey(PREVIOUS_KEY_ENV, previous) : null,
  }
}

/**
 * The destination as the token is bound to it: scheme and host lower-cased
 * (URL does that), no trailing slash, so cosmetic differences in what a
 * person typed do not lock a saved token out.
 */
export function bindingOf(baseUrl: string): string {
  const url = new URL(baseUrl.trim())
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`
}

/** Seals to a `v1:<iv>:<tag>:<ciphertext>` envelope (base64url parts). */
export function sealToken(token: string, baseUrl: string, keys: KeyRing): string {
  // A fresh random IV per value: reusing one under a GCM key reveals the XOR
  // of two plaintexts and lets an attacker forge tags.
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keys.current, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(bindingOf(baseUrl), "utf8"))
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":")
}

function tryOpen(key: Buffer, aad: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  } catch {
    // final() throws on a tag mismatch: wrong key, wrong destination or
    // tampered data. The caller decides whether another key is worth trying.
    return null
  }
}

export function openToken(sealed: string, baseUrl: string, keys: KeyRing): string {
  const parts = sealed.split(":")
  // The version prefix lets a later format (a key id, another cipher) sit
  // beside v1 without guessing what old rows contain.
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DecryptionError("Not a v1 sealed token.")
  }
  const iv = Buffer.from(parts[1], "base64url")
  const tag = Buffer.from(parts[2], "base64url")
  const ciphertext = Buffer.from(parts[3], "base64url")
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError("Sealed token has a malformed IV or tag.")
  }
  const aad = Buffer.from(bindingOf(baseUrl), "utf8")
  for (const key of [keys.current, keys.previous]) {
    if (!key) continue
    const token = tryOpen(key, aad, iv, tag, ciphertext)
    if (token !== null) return token
  }
  throw new DecryptionError(
    `The saved token could not be opened with ${KEY_ENV} or ${PREVIOUS_KEY_ENV} for this base URL (wrong key, changed URL or tampered data).`
  )
}
