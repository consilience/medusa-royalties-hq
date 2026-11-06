import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AdminError } from "../../../lib/admin/settings"
import { ROYALTIES_HQ_MODULE } from "../../../modules/royaltiesHq"

export const storeOf = (req: AuthenticatedMedusaRequest) => req.scope.resolve<any>(ROYALTIES_HQ_MODULE)
export const actorOf = (req: AuthenticatedMedusaRequest) => req.auth_context?.actor_id ?? null

// Known refusals become their status and code; anything else is Medusa's to
// report, so a bug is never dressed up as a validation message.
export async function answer(res: MedusaResponse, work: () => Promise<unknown>) {
  try {
    res.json(await work())
  } catch (e) {
    if (e instanceof AdminError) {
      res.status(e.status).json({ code: e.code, message: e.message })
      return
    }
    throw e
  }
}
