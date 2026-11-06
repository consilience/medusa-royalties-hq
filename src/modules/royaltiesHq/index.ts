import type { ModuleExports } from "@medusajs/framework/types"
import { Module } from "@medusajs/framework/utils"
import startupChecksLoader from "./loaders/startup-checks"
import RoyaltiesHqModuleService from "./service"

export const ROYALTIES_HQ_MODULE = "royaltiesHq"

const royaltiesHqModule = Module(ROYALTIES_HQ_MODULE, {
  service: RoyaltiesHqModuleService,
  loaders: [startupChecksLoader],
})

// Cast so the declaration names @medusajs/framework, which a store has, rather
// than @medusajs/types, which it may not.
export default royaltiesHqModule as ModuleExports<typeof RoyaltiesHqModuleService>
