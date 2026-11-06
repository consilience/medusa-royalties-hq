import {
  DecryptionError,
  EncryptionKeyError,
  loadKeyRing,
  openToken,
  sealToken,
} from "../seal"

const KEY_A = Buffer.alloc(32, 1).toString("base64")
const KEY_B = Buffer.alloc(32, 2).toString("base64")
const URL_1 = "https://acme.royaltieshq.com/api/v1"
const URL_2 = "https://other.example.com/api/v1"
const TOKEN = "rhq_live_abcdefghijklmnopqrstuvwxyz0123456789"

describe("loadKeyRing", () => {
  it("is null when no key is set, so the admin can say token entry is off", () => {
    expect(loadKeyRing({})).toBeNull()
    expect(loadKeyRing({ ROYALTIES_HQ_ENCRYPTION_KEY: "  " })).toBeNull()
  })

  it("refuses a key that is not 32 bytes of base64", () => {
    expect(() => loadKeyRing({ ROYALTIES_HQ_ENCRYPTION_KEY: "short" })).toThrow(EncryptionKeyError)
    expect(() =>
      loadKeyRing({ ROYALTIES_HQ_ENCRYPTION_KEY: KEY_A, ROYALTIES_HQ_ENCRYPTION_KEY_PREVIOUS: "bad" }),
    ).toThrow(EncryptionKeyError)
  })

  it("never names the key's value in its error", () => {
    try {
      loadKeyRing({ ROYALTIES_HQ_ENCRYPTION_KEY: "c2VjcmV0LXNob3J0" })
    } catch (e) {
      expect(String(e)).not.toContain("c2VjcmV0LXNob3J0")
    }
  })
})

describe("sealToken / openToken", () => {
  const ring = loadKeyRing({ ROYALTIES_HQ_ENCRYPTION_KEY: KEY_A })!

  it("round-trips, and the envelope does not contain the token", () => {
    const sealed = sealToken(TOKEN, URL_1, ring)
    expect(sealed).toMatch(/^v1:/)
    expect(sealed).not.toContain(TOKEN)
    expect(sealed).not.toContain("abcdefghij")
    expect(openToken(sealed, URL_1, ring)).toBe(TOKEN)
  })

  it("uses a fresh IV every time", () => {
    expect(sealToken(TOKEN, URL_1, ring)).not.toBe(sealToken(TOKEN, URL_1, ring))
  })

  it("will not open a token for a different base URL: it was entered for one destination", () => {
    const sealed = sealToken(TOKEN, URL_1, ring)
    expect(() => openToken(sealed, URL_2, ring)).toThrow(DecryptionError)
  })

  it("treats a trailing slash and host case as the same destination", () => {
    const sealed = sealToken(TOKEN, "https://ACME.royaltieshq.com/api/v1/", ring)
    expect(openToken(sealed, URL_1, ring)).toBe(TOKEN)
  })

  it("fails on a tampered envelope or the wrong key", () => {
    const sealed = sealToken(TOKEN, URL_1, ring)
    const parts = sealed.split(":")
    const flipped = Buffer.from(parts[3], "base64url")
    flipped[0] ^= 1
    parts[3] = flipped.toString("base64url")
    expect(() => openToken(parts.join(":"), URL_1, ring)).toThrow(DecryptionError)
    const other = loadKeyRing({ ROYALTIES_HQ_ENCRYPTION_KEY: KEY_B })!
    expect(() => openToken(sealed, URL_1, other)).toThrow(DecryptionError)
  })

  it("opens with the previous key during a rotation", () => {
    const old = loadKeyRing({ ROYALTIES_HQ_ENCRYPTION_KEY: KEY_A })!
    const sealed = sealToken(TOKEN, URL_1, old)
    const rotated = loadKeyRing({
      ROYALTIES_HQ_ENCRYPTION_KEY: KEY_B,
      ROYALTIES_HQ_ENCRYPTION_KEY_PREVIOUS: KEY_A,
    })!
    expect(openToken(sealed, URL_1, rotated)).toBe(TOKEN)
  })

  it("rejects a malformed envelope without echoing it", () => {
    expect(() => openToken("v2:junk", URL_1, ring)).toThrow(DecryptionError)
    try {
      openToken("v1:a:b:c", URL_1, ring)
    } catch (e) {
      expect(String(e)).not.toContain("v1:a:b:c")
    }
  })
})
