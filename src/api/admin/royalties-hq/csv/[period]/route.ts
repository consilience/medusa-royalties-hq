import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { isPeriod } from "../../../../../core/period"
import { pushDepsFrom } from "../../../../../lib/medusa/push-deps"
import { AdminError } from "../../../../../lib/admin/settings"
import { periodCsv } from "../../../../../lib/push/csv"

// Download CSV: the month a push would send, as RHQ's import template.
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const period = req.params.period ?? ""
  if (!isPeriod(period)) {
    res.status(400).json({ code: "period_invalid", message: "Give the month as YYYY-MM." })
    return
  }
  let csv
  try {
    csv = await periodCsv(await pushDepsFrom(req.scope), period)
  } catch (e) {
    if (!(e instanceof AdminError)) throw e
    res.status(e.status).json({ code: e.code, message: e.message })
    return
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8")
  res.setHeader("Content-Disposition", `attachment; filename="${csv.filename}"`)
  // Sales figures: never kept by a shared cache or the browser's.
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("X-Row-Count", String(csv.rowCount))
  res.send(csv.body)
}
