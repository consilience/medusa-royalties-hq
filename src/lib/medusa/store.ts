/**
 * The store.id sent to RHQ. RHQ binds a connection to the first live
 * store.id it accepts, so an empty one would bind it to nothing useful and
 * then refuse the real store.
 */
export function storeIdOf(medusaStoreId: string): string {
  if (typeof medusaStoreId !== "string" || medusaStoreId.trim() === "") {
    throw new Error("Medusa store id is missing; cannot name this store to Royalties HQ")
  }
  return `medusa:${medusaStoreId}`
}
