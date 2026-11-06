import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { resolveEndpoint } from "../../../../lib/admin/settings"
import { recordTestedConnection } from "../../../../lib/admin/status"
import { createModulePushStore } from "../../../../lib/push/moduleStore"
import { createRhqHandshake } from "../../../../lib/rhq/handshake"
import { answer, storeOf } from "../helpers"

// Test connection: a fresh handshake with the token the plugin would push
// with. The answer carries the connection's name and the token's mode and
// expiry, never the token. A live answer is recorded, so the status page
// shows the months of the connection this token belongs to.
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  await answer(res, async () => {
    const result = await createRhqHandshake().testConnection(await resolveEndpoint(storeOf(req), process.env))
    await recordTestedConnection(createModulePushStore(storeOf(req)), result)
    return result
  })
}
