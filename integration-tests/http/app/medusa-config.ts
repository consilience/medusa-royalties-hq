// The HTTP harness's Medusa app: only this config. The plugin is loaded from
// the repo root by absolute path, which Medusa reads from .medusa/server, so
// the harness always runs after `npm run build`.
import path from "node:path"
import { defineConfig, loadEnv } from "@medusajs/framework/utils"
import { HARNESS } from "../harness"

loadEnv("test", process.cwd())
process.env.ROYALTIES_HQ_ENCRYPTION_KEY ??= HARNESS.encryptionKey
// The stand-in RHQ (helpers/rhq-server.ts) is plain http on loopback.
process.env.ROYALTIES_HQ_ALLOW_HTTP ??= "true"
process.env.ROYALTIES_HQ_ALLOW_PRIVATE_HOSTS ??= "true"

const root = path.resolve(__dirname, "../../..")

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      jwtSecret: HARNESS.jwtSecret,
      cookieSecret: HARNESS.jwtSecret,
      storeCors: "*",
      adminCors: "*",
      authCors: "*",
    },
  },
  admin: { disable: true },
  plugins: [{ resolve: root, options: { backendUrl: "https://store.example.test" } }],
  modules: [
    {
      resolve: "@medusajs/medusa/notification",
      options: {
        providers: [{ resolve: "@medusajs/medusa/notification-local", id: "local", options: { channels: ["feed"] } }],
      },
    },
  ],
})
