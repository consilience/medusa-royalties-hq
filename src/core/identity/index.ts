// Public identity API for the pure core: what RHQ matches a row on, and the
// key rows are aggregated by.
export { isValidIsbn10, isValidIsbn13, normaliseIsbn } from "./isbn";
export {
  aggregationKey,
  IDENTIFIER_MAX_LENGTH,
  parseStoreProductId,
  resolveIdentifiers,
} from "./identifiers";
export type {
  IdentifierSource,
  Identifiers,
  IdentifierWarning,
  ResolvedIdentifiers,
} from "./identifiers";
export { pickIsbnSource } from "./source";
export type { IsbnCandidates, IsbnSource } from "./source";
