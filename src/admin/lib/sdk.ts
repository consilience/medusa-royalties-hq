import Medusa from "@medusajs/js-sdk"

// A plugin's admin code is built by the host, which injects these: the
// backend's URL and the auth type it is configured for. Hard-coding either
// breaks a host that differs (a JWT-configured admin, a separate backend).
export const sdk = new Medusa({
  baseUrl: (typeof __BACKEND_URL__ !== "undefined" && __BACKEND_URL__) || "/",
  auth: { type: (typeof __AUTH_TYPE__ !== "undefined" && __AUTH_TYPE__) || "session" },
})
