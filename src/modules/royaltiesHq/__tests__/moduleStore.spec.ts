import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { ROYALTIES_HQ_MODULE } from ".."
import { createModulePushStore } from "../../../lib/push/moduleStore"
import { describePushStoreContract } from "../../../lib/push/__tests__/support/pushStoreContract"
import { MODELS } from "../models"
import RoyaltiesHqModuleService from "../service"

jest.setTimeout(60 * 1000)

// A real database failure, planted on the table each atomic group writes
// last (rhq_sale_context), so the group's earlier writes have already reached
// the database when it fails. The runner drops the schema after every test,
// trigger included.
const PLANT_FAILURE = `
  CREATE OR REPLACE FUNCTION rhq_test_fail() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'planted failure'; END $$ LANGUAGE plpgsql;
  CREATE TRIGGER rhq_test_fail BEFORE INSERT OR UPDATE ON rhq_sale_context
  FOR EACH STATEMENT EXECUTE FUNCTION rhq_test_fail();
`

moduleIntegrationTestRunner<RoyaltiesHqModuleService>({
  moduleName: ROYALTIES_HQ_MODULE,
  moduleModels: Object.values(MODELS),
  resolve: "./src/modules/royaltiesHq",
  testSuite: ({ service, MikroOrmWrapper }) => {
    describe("module PushStore", () => {
      describePushStoreContract(() => ({
        store: createModulePushStore(service),
        seedSettings: async (s) => {
          await service.appendSettingsVersion(s, null)
        },
        failNext: async () => {
          await MikroOrmWrapper.forkManager().execute(PLANT_FAILURE)
        },
        frozenAs: async (connectionId, orderId) => {
          const [row] = await service.listRhqSaleContexts({ connection_id: connectionId, order_id: orderId })
          return row ? { at: row.frozen_at ?? null, reason: (row.frozen_reason as any) ?? null } : null
        },
      }))
    })
  },
})
