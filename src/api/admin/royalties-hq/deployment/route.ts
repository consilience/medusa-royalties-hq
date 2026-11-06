import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AdminError } from "../../../../lib/admin/settings"
import { confirmDeployment, statusView } from "../../../../lib/admin/status"
import { deploymentHere } from "../../../../lib/medusa/push-deps"
import { createModulePushStore } from "../../../../lib/push/moduleStore"
import { answer, storeOf } from "../helpers"

// A person confirms the store has moved here (a new domain, a new server):
// this deployment sends from now on.
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  await answer(res, async () => {
    const store = createModulePushStore(storeOf(req))
    const here = await deploymentHere(req.scope)
    if (!(await confirmDeployment(store, here))) {
      throw new AdminError(409, "origin_unknown", "Set the plugin's backendUrl option or MEDUSA_BACKEND_URL so this deployment can be recorded.")
    }
    return statusView(store, { now: new Date(), ...here })
  })
}
