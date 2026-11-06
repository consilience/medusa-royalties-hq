import { detectLocking, startupMessages } from "../checks"

const redis = { modules: { locking: { options: { providers: [{ resolve: "@medusajs/medusa/locking-redis", id: "r", is_default: true }] } } } }
const postgres = { modules: { locking: { options: { providers: [{ resolve: "@medusajs/medusa/locking-postgres", id: "p" }] } } } }

describe("detectLocking", () => {
  it("is in-memory with no locking module configured", () => {
    expect(detectLocking({})).toEqual({ provider: "in-memory", postgresConfigured: false, supported: true })
  })
  it("reads the default provider", () => {
    expect(detectLocking(redis).provider).toBe("redis")
    expect(detectLocking(postgres)).toEqual({ provider: "postgres", postgresConfigured: true, supported: false })
  })
})

describe("startupMessages", () => {
  const quiet = { ROYALTIES_HQ_API_TOKEN: "rhq_live_x" }

  it("errors on in-memory locking when the server and worker run as separate processes", () => {
    const messages = startupMessages({}, { ...quiet, MEDUSA_WORKER_MODE: "worker" })
    expect(messages).toContainEqual(expect.objectContaining({ level: "error", text: expect.stringContaining("in-memory") }))
  })

  it("says nothing about locking for a single shared process", () => {
    expect(startupMessages({}, { ...quiet, MEDUSA_WORKER_MODE: "shared" }).filter((m) => m.level !== "info")).toEqual([])
  })

  it("errors on Postgres locking, which can let two pushes through", () => {
    expect(startupMessages(postgres, quiet)).toContainEqual(expect.objectContaining({ level: "error" }))
  })

  it("warns when there is neither an env token nor an encryption key, so no token can be set", () => {
    expect(startupMessages(redis, {})).toContainEqual(
      expect.objectContaining({ level: "warn", text: expect.stringContaining("ROYALTIES_HQ_ENCRYPTION_KEY") })
    )
    expect(startupMessages(redis, { ROYALTIES_HQ_ENCRYPTION_KEY: "k" }).filter((m) => m.level === "warn")).toEqual([])
  })

  it("never puts the token in a message", () => {
    const text = JSON.stringify(startupMessages(redis, { ROYALTIES_HQ_API_TOKEN: "rhq_live_SECRETSECRET" }))
    expect(text).not.toContain("SECRETSECRET")
  })
})
