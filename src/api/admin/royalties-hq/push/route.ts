import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { isPeriod } from "../../../../core/period"
import { pushDepsFrom } from "../../../../lib/medusa/push-deps"
import { createSnapshotActions } from "../../../../lib/push/actions"

// Push now and Dry run for one month. Inline, not queued: the person is
// waiting for RHQ's answer, and the push lock keeps it from overlapping a
// scheduled push.
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as { period?: unknown; dry_run?: unknown }
  if (typeof body.period !== "string" || !isPeriod(body.period)) {
    res.status(400).json({ code: "period_invalid", message: "Give the month as YYYY-MM." })
    return
  }
  const actions = createSnapshotActions(await pushDepsFrom(req.scope))
  res.json(body.dry_run === true ? await actions.validate(body.period) : await actions.push(body.period))
}
