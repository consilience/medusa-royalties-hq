import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { deleteToken, putToken } from "../../../../lib/admin/settings"
import { forgetConnection } from "../../../../lib/admin/status"
import { createModulePushStore } from "../../../../lib/push/moduleStore"
import { actorOf, answer, storeOf } from "../helpers"

// Write-only: neither handler ever returns the token, only its summary.
// A new token may belong to another connection, so the one last handshaken
// with is marked unconfirmed (lib/admin/status.ts).
export async function PUT(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  await answer(res, async () => {
    const view = await putToken(storeOf(req), (req.body as any)?.token, actorOf(req), process.env)
    await forgetConnection(createModulePushStore(storeOf(req)), new Date())
    return view
  })
}

export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  await answer(res, async () => {
    // No token names no new connection: the last one's history still holds.
    return deleteToken(storeOf(req), actorOf(req), process.env)
  })
}
