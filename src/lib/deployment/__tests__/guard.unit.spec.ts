import { checkDeployment, deploymentOrigin } from "../guard"

describe("deploymentOrigin", () => {
  it("prefers the plugin option, then MEDUSA_BACKEND_URL, and keeps only the origin", () => {
    expect(deploymentOrigin({ backendUrl: "https://API.shop.example.test/app/" }, { MEDUSA_BACKEND_URL: "https://x.example" })).toBe(
      "https://api.shop.example.test"
    )
    expect(deploymentOrigin({}, { MEDUSA_BACKEND_URL: "http://localhost:9000/" })).toBe("http://localhost:9000")
  })

  it("is null when neither is set or the value is not a URL", () => {
    expect(deploymentOrigin({}, {})).toBeNull()
    expect(deploymentOrigin({ backendUrl: "not a url" }, {})).toBeNull()
  })
})

describe("checkDeployment", () => {
  const recorded = { origin: "https://api.shop.example.test", storeId: "store_1" }

  it("passes when origin and store match what was recorded", () => {
    expect(checkDeployment(recorded, { origin: "https://api.shop.example.test", storeId: "store_1" })).toEqual({ ok: true })
  })

  it("refuses a different origin: a staging clone, or a move a person has not confirmed", () => {
    const result = checkDeployment(recorded, { origin: "https://staging.shop.example.test", storeId: "store_1" })
    expect(result).toEqual({
      ok: false,
      code: "deployment_changed",
      recordedOrigin: "https://api.shop.example.test",
      currentOrigin: "https://staging.shop.example.test",
    })
  })

  it("refuses a different store id on the same origin", () => {
    expect(checkDeployment(recorded, { origin: "https://api.shop.example.test", storeId: "store_2" })).toMatchObject({
      ok: false,
      code: "deployment_changed",
    })
  })

  it("refuses when this deployment's origin is unknown, because nothing can then tell a clone apart", () => {
    expect(checkDeployment(recorded, { origin: null, storeId: "store_1" })).toEqual({ ok: false, code: "origin_unknown" })
    expect(checkDeployment(null, { origin: null, storeId: "store_1" })).toEqual({ ok: false, code: "origin_unknown" })
  })

  it("refuses when nothing was recorded yet: enabling records it, so a live push without a record is a fault", () => {
    expect(checkDeployment(null, { origin: "https://api.shop.example.test", storeId: "store_1" })).toEqual({
      ok: false,
      code: "deployment_unrecorded",
    })
  })
})
