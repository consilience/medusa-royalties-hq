import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { saveVariant } from "../../../../../lib/admin/variants"
import { AdminError } from "../../../../../lib/admin/settings"
import { storeOf } from "../../helpers"

const PROBLEM: Record<string, (id: string) => string> = {
  duplicate: (id) => `${id} is listed twice.`,
  component_missing: (id) => `${id} is not a variant in this store.`,
  quantity_invalid: (id) => `${id} needs a whole quantity from 1 to 999.`,
  cycle: (id) => `${id} contains this variant, so the bundle would contain itself.`,
}
// The admin SDK surfaces only a refusal's message, so it carries every problem.
const describe = (errors: string[]) =>
  errors.map((e) => {
    const [code, id = ""] = e.split(/:(.*)/s)
    return PROBLEM[code!]?.(id) ?? e
  }).join(" ")

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const result = await saveVariant(req.scope.resolve(ContainerRegistrationKeys.QUERY), storeOf(req), req.params.id, (req.body ?? {}) as Record<string, unknown>)
    if ("errors" in result) {
      res.status(400).json({ code: "composition_invalid", message: describe(result.errors ?? []), errors: result.errors })
      return
    }
    res.json(result)
  } catch (e) {
    if (!(e instanceof AdminError)) throw e
    res.status(e.status).json({ code: e.code, message: e.message })
  }
}
