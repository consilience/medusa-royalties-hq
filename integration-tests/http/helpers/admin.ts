// Admin auth for the harness, as the Medusa docs page on testing API routes
// describes: a user, an emailpass auth identity, and a JWT signed with the
// harness's jwtSecret.
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import jwt from "jsonwebtoken"
import { HARNESS } from "../harness"

export type Headers = { headers: Record<string, string> }

export async function adminHeaders(container: MedusaContainer): Promise<Headers & { userId: string }> {
  const users = container.resolve(Modules.USER)
  const auth = container.resolve(Modules.AUTH)
  const user = await users.createUsers({ email: `admin-${Date.now()}@harness.test` })
  const identity = await auth.createAuthIdentities({
    provider_identities: [{ provider: "emailpass", entity_id: user.email }],
    app_metadata: { user_id: user.id },
  })
  const token = jwt.sign({ actor_id: user.id, actor_type: "user", auth_identity_id: identity.id }, HARNESS.jwtSecret, {
    expiresIn: "1d",
  })
  return { headers: { authorization: `Bearer ${token}` }, userId: user.id }
}
