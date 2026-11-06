import { createSafeFetch } from "../safeFetch"

// The jest setup file refuses every request to a real Royalties HQ host. The
// client sends through node:http(s), not global fetch, so the guard must sit
// there too; this proves it does, without any network.
describe("the test-run guard against real Royalties HQ hosts", () => {
  it("refuses a safeFetch request before it resolves or connects", async () => {
    const resolver = jest.fn(async () => [{ address: "93.184.216.34", family: 4 }])
    const send = createSafeFetch({ resolver, policy: { allowHttp: false, allowPrivateHosts: false } } as any)
    await expect(send("https://acme.royaltieshq.com/api/v1/connection")).rejects.toThrow(/real Royalties HQ host/)
    expect(resolver).not.toHaveBeenCalled()
  })
})
