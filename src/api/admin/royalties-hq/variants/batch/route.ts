import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { includeVariants } from "../../../../../lib/admin/variants"
import { answer, storeOf } from "../../helpers"

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as Record<string, unknown>
  await answer(res, () => includeVariants(req.scope.resolve(ContainerRegistrationKeys.QUERY), storeOf(req), body.variant_ids, body.include))
}
