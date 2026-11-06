import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { readSettings } from "../../../../lib/admin/settings"
import { listVariants } from "../../../../lib/admin/variants"
import { answer, storeOf } from "../helpers"

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const store = storeOf(req)
  const { settings } = await readSettings(store, process.env)
  const num = (v: unknown, d: number) => (typeof v === "string" && /^\d+$/.test(v) ? parseInt(v, 10) : d)
  await answer(res, () =>
    listVariants(req.scope.resolve(ContainerRegistrationKeys.QUERY), store, {
      offset: num(req.query.offset, 0),
      limit: num(req.query.limit, 50),
      isbnSource: settings.isbn_source,
    }),
  )
}
