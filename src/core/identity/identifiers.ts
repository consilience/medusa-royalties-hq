import { normaliseIsbn } from "./isbn";

// The API's `Identifiers` schema caps every field at 255 characters.
// JSON Schema's maxLength counts code points,
// not UTF-16 units, so the check below does too.
export const IDENTIFIER_MAX_LENGTH = 255;

/**
 * The part of the core's ProductConfig that identity resolution reads.
 * Declared structurally here so this module does not depend on where the
 * full ProductConfig lives; any ProductConfig satisfies it.
 */
export interface IdentifierSource {
  rhqProductId: string | null;
  /**
   * From the configured ISBN source, resolved at the edge (pickIsbnSource for
   * the variant fields, or a metadata key).
   */
  isbnSourceValue: string | null;
  sku: string | null;
  asin: string | null;
}

/** Wire shape of the API's `Identifiers` object; field names match the API. */
export interface Identifiers {
  rhq_product_id: string | null;
  isbn: string | null;
  sku: string | null;
  asin: string | null;
  store_product_id: string | null;
}

export type IdentifierWarning = "invalid_isbn" | "identifier_too_long";

export interface ResolvedIdentifiers {
  identifiers: Identifiers;
  /** Each code at most once, in the order first raised. */
  warnings: IdentifierWarning[];
  /**
   * False when none of rhq_product_id/isbn/sku/asin survives. The API refuses
   * such a row, so the caller must exclude it and report it
   * (`summary.lines_without_identifier`) rather than send it.
   */
  sendable: boolean;
}

// C0, DEL and C1 controls. They arrive from CSV imports and metadata (a
// stray CR, a NUL), are invisible in the admin, and would make two
// identifiers that look identical aggregate and match differently in RHQ.
const CONTROL = /\p{Cc}/gu;

type Cleaned =
  { kind: "blank" } | { kind: "too_long" } | { kind: "value"; value: string };

// Control characters go first so a value like "\u0000 " counts as blank and a
// trailing "\r\n" does not survive the trim.
function clean(raw: string | null): Cleaned {
  if (raw === null) {
    return { kind: "blank" };
  }
  const value = raw.replace(CONTROL, "").trim();
  if (value === "") {
    return { kind: "blank" };
  }
  // Truncating would send a different identifier that might match a
  // different product (or silently match none), so an over-long value is
  // dropped and reported instead.
  if ([...value].length > IDENTIFIER_MAX_LENGTH) {
    return { kind: "too_long" };
  }
  return { kind: "value", value };
}

/**
 * The variant id as RHQ's audit-only `store_product_id`, trimmed. Null when
 * blank or too long.
 */
export function parseStoreProductId(variantId: string): string | null {
  const id = variantId.trim();
  if (id === "" || [...id].length > IDENTIFIER_MAX_LENGTH) return null;
  return id;
}

/**
 * Resolves what RHQ should match a variant's rows on.
 *
 * A non-blank `rhqProductId` override is the only identifier sent: the
 * publisher set it because the store's own ISBN/SKU/ASIN match the wrong RHQ
 * product or none, and RHQ would otherwise try all of them. Without an
 * override, ISBN, SKU and ASIN are each sent when usable. `store_product_id`
 * is always filled when parseable because it is audit only and never matched.
 */
export function resolveIdentifiers(
  config: IdentifierSource,
  variantId: string,
): ResolvedIdentifiers {
  const warnings = new Set<IdentifierWarning>();
  const identifiers: Identifiers = {
    rhq_product_id: null,
    isbn: null,
    sku: null,
    asin: null,
    store_product_id: parseStoreProductId(variantId),
  };

  const override = clean(config.rhqProductId);
  if (override.kind === "value") {
    identifiers.rhq_product_id = override.value;
  } else if (override.kind === "too_long") {
    // An unusable override must not fall back to the other identifiers:
    // those are the ones the publisher overrode, so sending them would
    // attribute sales to the product they meant to avoid.
    warnings.add("identifier_too_long");
  } else {
    const isbn = clean(config.isbnSourceValue);
    if (isbn.kind === "value") {
      identifiers.isbn = normaliseIsbn(isbn.value);
      if (identifiers.isbn === null) {
        warnings.add("invalid_isbn");
      }
    } else if (isbn.kind === "too_long") {
      // No ISBN is 255 characters long, so this is an invalid ISBN first.
      warnings.add("invalid_isbn");
    }

    for (const field of ["sku", "asin"] as const) {
      const cleaned = clean(config[field]);
      if (cleaned.kind === "value") {
        identifiers[field] = cleaned.value;
      } else if (cleaned.kind === "too_long") {
        warnings.add("identifier_too_long");
      }
    }
  }

  return {
    identifiers,
    warnings: [...warnings],
    sendable:
      identifiers.rhq_product_id !== null ||
      identifiers.isbn !== null ||
      identifiers.sku !== null ||
      identifiers.asin !== null,
  };
}

/**
 * The identifier part of the row aggregation key:
 * (rhq_product_id | isbn, sku, asin). `store_product_id` is left out because
 * several variants resolving to the same identifiers are one RHQ product and
 * must become one row.
 *
 * JSON of a fixed-order tuple is unambiguous by construction: strings are
 * quoted and escaped, so no value can forge a separator, and null stays
 * distinct from "null" and "". The override and the ISBN keep separate slots
 * so an override that happens to look like an ISBN does not merge with it.
 */
export function aggregationKey(identifiers: Identifiers): string {
  return JSON.stringify([
    identifiers.rhq_product_id,
    identifiers.isbn,
    identifiers.sku,
    identifiers.asin,
  ]);
}
