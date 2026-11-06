// A store's own code using the installed package's public entry points.
// scripts/install-test.sh type-checks it under strict settings; it is never
// run. The @ts-expect-error fails the check if the module's type has become
// `any`.
import royaltiesHqModule, { ROYALTIES_HQ_MODULE } from "@royaltieshq/medusa-royalties-hq/modules/royaltiesHq"

// A store resolving the module's service by name, as its own routes would.
export const moduleName: "royaltiesHq" = ROYALTIES_HQ_MODULE
export const service: unknown = royaltiesHqModule.service

// @ts-expect-error the module has no such member
void royaltiesHqModule.notAMember
