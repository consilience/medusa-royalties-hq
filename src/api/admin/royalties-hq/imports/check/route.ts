import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { pushDepsFrom } from "../../../../../lib/medusa/push-deps"
import { createSnapshotActions } from "../../../../../lib/push/actions"

// Check RHQ status: asks RHQ about each staged month, at most once a minute.
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  res.json(await createSnapshotActions(await pushDepsFrom(req.scope)).checkImports())
}
