import RhqPushAttempt from "./rhq-push-attempt"
import RhqSaleContext from "./rhq-sale-context"
import RhqSecret from "./rhq-secret"
import RhqSettings from "./rhq-settings"
import RhqSnapshot from "./rhq-snapshot"
import RhqState from "./rhq-state"
import RhqVariant from "./rhq-variant"

// Typed by the models themselves: an inferred type would spell out their
// schemas through @medusajs/utils, a package the plugin does not depend on.
export const MODELS: {
  RhqSettings: typeof RhqSettings
  RhqSecret: typeof RhqSecret
  RhqVariant: typeof RhqVariant
  RhqSnapshot: typeof RhqSnapshot
  RhqPushAttempt: typeof RhqPushAttempt
  RhqSaleContext: typeof RhqSaleContext
  RhqState: typeof RhqState
} = {
  RhqSettings,
  RhqSecret,
  RhqVariant,
  RhqSnapshot,
  RhqPushAttempt,
  RhqSaleContext,
  RhqState,
}
