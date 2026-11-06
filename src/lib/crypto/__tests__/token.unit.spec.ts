import { resolveToken, summariseToken } from "../token"

const ENV_TOKEN = "rhq_live_FROM_ENVIRONMENT_0123456789wxyz"

describe("resolveToken", () => {
  it("prefers the environment token over a stored one", () => {
    expect(
      resolveToken({ ROYALTIES_HQ_API_TOKEN: ENV_TOKEN }, () => "rhq_live_stored_aaaaaaaaaaaaaaaa"),
    ).toEqual({ source: "env", token: ENV_TOKEN })
  })

  it("falls back to the stored token, then to none", () => {
    expect(resolveToken({}, () => "rhq_live_stored_aaaaaaaaaaaaaaaa")).toEqual({
      source: "stored",
      token: "rhq_live_stored_aaaaaaaaaaaaaaaa",
    })
    expect(resolveToken({ ROYALTIES_HQ_API_TOKEN: "  " }, () => null)).toEqual({ source: "none", token: null })
  })

  it("does not read the store at all when the environment supplies the token", () => {
    const stored = jest.fn(() => "x")
    resolveToken({ ROYALTIES_HQ_API_TOKEN: ENV_TOKEN }, stored)
    expect(stored).not.toHaveBeenCalled()
  })
})

describe("summariseToken", () => {
  it("shows only the source, test mode and last four characters", () => {
    expect(summariseToken({ source: "env", token: ENV_TOKEN })).toEqual({
      set: true,
      source: "env",
      lastFour: "wxyz",
      testMode: false,
    })
    expect(summariseToken({ source: "stored", token: "rhq_test_0123456789abcdefgh" })).toEqual({
      set: true,
      source: "stored",
      lastFour: "efgh",
      testMode: true,
    })
  })

  it("reveals nothing of a short token, and nothing when unset", () => {
    expect(summariseToken({ source: "stored", token: "rhq_live_abc" }).lastFour).toBeNull()
    expect(summariseToken({ source: "none", token: null })).toEqual({
      set: false,
      source: "none",
      lastFour: null,
      testMode: false,
    })
  })

  it("never contains the token", () => {
    expect(JSON.stringify(summariseToken({ source: "env", token: ENV_TOKEN }))).not.toContain("FROM_ENVIRONMENT")
  })
})
