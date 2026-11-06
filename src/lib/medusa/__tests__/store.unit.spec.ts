import { storeIdOf } from "../store"

describe("storeIdOf", () => {
  it("names the store as medusa:<store id>", () => {
    expect(storeIdOf("store_01M6KE7")).toBe("medusa:store_01M6KE7")
  })
  it("refuses an empty or missing store id rather than binding RHQ to nothing", () => {
    expect(() => storeIdOf("")).toThrow(/store id/)
    expect(() => storeIdOf(undefined as any)).toThrow(/store id/)
  })
})
