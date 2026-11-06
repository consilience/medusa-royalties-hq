import { describePushStoreContract } from "./support/pushStoreContract"
import { memoryStore } from "./support/memoryStore"

describe("memory PushStore", () => {
  describePushStoreContract(() => {
    const store = memoryStore()
    return {
      store,
      seedSettings: async (s) => store.saveSettings(s),
      failNext: async (method) => store.failNext(method),
      frozenAs: async (connectionId, orderId) => {
        const c = store.data.saleContexts.find((x) => x.connection_id === connectionId && x.order_id === orderId)
        return c ? { at: c.frozen_at, reason: c.frozen_reason } : null
      },
    }
  })
})
