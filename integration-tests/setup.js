const { MetadataStorage } = require("@medusajs/framework/mikro-orm/core")

MetadataStorage.clear()

// No test may send anything to a real Royalties HQ install. Every test talks
// to a fake, so any request to a
// royaltieshq.com host is refused here, before it leaves the machine.
const realFetch = globalThis.fetch
const hostnameOf = (href) => {
  try {
    return new URL(String(href)).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return null
  }
}
globalThis.fetch = function refuseRealRhq(input, init) {
  if (
    [input?.url, input].some((href) => {
      const host = hostnameOf(href)
      return host === "royaltieshq.com" || host?.endsWith(".royaltieshq.com")
    })
  ) {
    return Promise.reject(new Error("test setup: refusing a request to a real Royalties HQ host"))
  }
  return realFetch(input, init)
}

// The RHQ client sends through node:http(s) so it can check the address it
// connects to; global fetch never sees those requests, so guard them here too.
const isRealRhq = (host) => {
  const h = String(host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "")
  return h === "royaltieshq.com" || h.endsWith(".royaltieshq.com")
}
for (const transport of [require("node:http"), require("node:https")]) {
  for (const method of ["request", "get"]) {
    const real = transport[method]
    transport[method] = function refuseRealRhqRequest(...args) {
      const target = args.find((a) => typeof a === "string" || a instanceof URL)
      const options = args.find((a) => a && typeof a === "object" && !(a instanceof URL))
      const host = target ? hostnameOf(target) : options?.hostname ?? options?.host
      if (isRealRhq(host) || isRealRhq(options?.hostname) || isRealRhq(options?.host)) {
        throw new Error("test setup: refusing a request to a real Royalties HQ host")
      }
      return real.apply(this, args)
    }
  }
}
