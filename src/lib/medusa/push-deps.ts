import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ROYALTIES_HQ_MODULE } from "../../modules/royaltiesHq"
import { AdminError, resolveEndpoint } from "../admin/settings"
import { deploymentOrigin } from "../deployment/guard"
import { createPushNotifier } from "../notify/notifier"
import { createModulePushStore } from "../push/moduleStore"
import type { PushDeps, PushLogger } from "../push/push"
import { createPeriodInputs } from "./period-inputs"

type Env = Record<string, string | undefined>

/** The store's id and default currency: the store a snapshot is about. */
async function storeFacts(query: any): Promise<{ storeId: string | null; currency: string }> {
  const { data } = await query.graph({ entity: "store", fields: ["id", "supported_currencies.currency_code", "supported_currencies.is_default"] })
  const store = data[0]
  const currencies: any[] = store?.supported_currencies ?? []
  const currency = (currencies.find((c) => c.is_default) ?? currencies[0])?.currency_code ?? "eur"
  return { storeId: store?.id ?? null, currency }
}

/** Where this process runs and which store it is, for the deployment guard. */
export async function deploymentHere(container: MedusaContainer, env: Env = process.env) {
  const service = container.resolve<any>(ROYALTIES_HQ_MODULE)
  const { storeId } = await storeFacts(container.resolve(ContainerRegistrationKeys.QUERY))
  return { origin: deploymentOrigin(service.pluginOptions ?? {}, env), storeId }
}

/**
 * The push step's dependencies from Medusa's container: the module store,
 * the locking module, the token (environment first, else the sealed one),
 * the store's id and this deployment's origin. The thin edge: everything it
 * wires is tested on its own.
 */
export async function pushDepsFrom(container: MedusaContainer, env: Env = process.env): Promise<PushDeps> {
  const service = container.resolve<any>(ROYALTIES_HQ_MODULE)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const medusaLogger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const store = createModulePushStore(service)
  const { storeId, currency } = await storeFacts(query)
  // Events carry ids, codes and counts only (never a token or order data).
  const logger: PushLogger = (event) => medusaLogger.info(`royalties-hq ${JSON.stringify(event)}`)
  const notifications = container.resolve<any>(Modules.NOTIFICATION, { allowUnregistered: true }) ?? null

  return {
    store,
    lock: container.resolve(Modules.LOCKING),
    loadPeriodInputs: createPeriodInputs({ query: query as any, variants: service, defaultCurrency: currency }),
    token: async () => {
      try {
        return (await resolveEndpoint(service, env)).token
      } catch (e) {
        // Nothing set is "not connected"; a token that is set but cannot be
        // used throws, so the push step says why.
        if (e instanceof AdminError && e.code === "not_configured") return null
        throw e
      }
    },
    storeId,
    deployment: { origin: deploymentOrigin(service.pluginOptions ?? {}, env) },
    logger,
    notify: createPushNotifier({ notifications, state: service, settings: () => store.currentSettings(), logger }),
  }
}
