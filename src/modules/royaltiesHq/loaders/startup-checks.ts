import type { LoaderOptions } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { startupMessages } from "../../../lib/startup/checks"

// Logs, once at startup, anything that would stop pushes being safe.
export default async function startupChecksLoader({ container }: LoaderOptions) {
  const config = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE, { allowUnregistered: true })
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  for (const { level, text } of startupMessages(config, process.env)) logger[level](text)
}
