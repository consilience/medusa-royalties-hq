import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { statusView } from "../../../../lib/admin/status"
import { deploymentHere } from "../../../../lib/medusa/push-deps"
import { createModulePushStore } from "../../../../lib/push/moduleStore"
import { answer, storeOf } from "../helpers"

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  await answer(res, async () => statusView(createModulePushStore(storeOf(req)), { now: new Date(), ...(await deploymentHere(req.scope)) }))
}
