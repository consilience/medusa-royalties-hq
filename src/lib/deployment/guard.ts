// Tells the live store apart from a copy of it.
//
// RHQ binds a connection to a store id, and a clone of
// the live database carries the same Medusa store id, the same settings and
// possibly a usable token. So enabling the plugin records this deployment's
// origin beside the store id, and every live push checks both. A copy running
// anywhere else (staging, a laptop) is refused before anything is sent, and
// a real move (a domain change the publisher expects) needs one confirmation in the
// admin, which records the new origin.

export type DeploymentRecord = { origin: string; storeId: string }

export type DeploymentCheck =
  | { ok: true }
  | { ok: false; code: "deployment_changed"; recordedOrigin: string; currentOrigin: string }
  | { ok: false; code: "deployment_unrecorded" }
  | { ok: false; code: "origin_unknown" }

/**
 * This deployment's origin: the plugin's `backendUrl` option, else
 * MEDUSA_BACKEND_URL. Only scheme, host and port count, so a path or a
 * trailing slash in either does not look like a move.
 */
export function deploymentOrigin(
  options: { backendUrl?: string },
  env: Record<string, string | undefined>
): string | null {
  const raw = options.backendUrl?.trim() || env.MEDUSA_BACKEND_URL?.trim()
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

export function checkDeployment(
  recorded: DeploymentRecord | null,
  current: { origin: string | null; storeId: string }
): DeploymentCheck {
  // Without an origin nothing distinguishes this process from a copy, so a
  // live push is refused rather than trusted.
  if (current.origin === null) return { ok: false, code: "origin_unknown" }
  if (recorded === null) return { ok: false, code: "deployment_unrecorded" }
  if (recorded.origin !== current.origin || recorded.storeId !== current.storeId) {
    return {
      ok: false,
      code: "deployment_changed",
      recordedOrigin: recorded.origin,
      currentOrigin: current.origin,
    }
  }
  return { ok: true }
}
