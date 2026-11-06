import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { readSettings, saveSettings } from "../../../../lib/admin/settings"
import { recordDeploymentOnEnable } from "../../../../lib/admin/status"
import { deploymentHere } from "../../../../lib/medusa/push-deps"
import { actorOf, answer, storeOf } from "../helpers"

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  await answer(res, () => readSettings(storeOf(req), process.env))
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const result = await saveSettings(storeOf(req), (req.body ?? {}) as Record<string, unknown>, actorOf(req), process.env)
  if ("errors" in result) {
    // The admin's SDK surfaces only `message`, so it carries every problem.
    res.status(400).json({ code: "settings_invalid", message: result.errors.map((e) => e.message).join(" "), errors: result.errors })
    return
  }
  await recordDeploymentOnEnable(storeOf(req), result.settings, await deploymentHere(req.scope))
  res.json(result)
}
