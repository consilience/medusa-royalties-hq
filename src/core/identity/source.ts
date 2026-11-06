import { normaliseIsbn } from "./isbn";

/**
 * Where a variant's ISBN is read from. `auto` is the default:
 * a store may keep the ISBN-13 in any of these fields (some keep it in both
 * `sku` and `ean`), so the first one that really is an ISBN wins and the
 * plugin works unconfigured. Naming a field pins it.
 *
 * A metadata key is also a valid setting, but its value is read at the edge
 * and passed to resolveIdentifiers directly; it never comes through here.
 */
export type IsbnSource = "auto" | "ean" | "barcode" | "upc" | "sku";

/** The variant's identifier fields, as Medusa holds them. */
export interface IsbnCandidates {
  ean: string | null;
  barcode: string | null;
  upc: string | null;
  sku: string | null;
}

const AUTO_ORDER = ["ean", "barcode", "upc", "sku"] as const;

// The same controls resolveIdentifiers strips before it normalises, so auto
// accepts exactly the values resolveIdentifiers would turn into an ISBN.
const CONTROL = /\p{Cc}/gu;

/**
 * The value to hand resolveIdentifiers as `isbnSourceValue`, returned as
 * stored: normalising and ISBN-10 conversion happen there, once.
 *
 * - `auto`: the first candidate, in the order ean, barcode, upc, sku, that is
 *   a valid ISBN-13 or ISBN-10. Null when none is, so a store whose barcodes
 *   are plain EANs is not told its ISBNs are invalid; the row still matches
 *   on SKU.
 * - A named field: its value as it is, valid or not. The publisher chose it,
 *   so an invalid value must reach resolveIdentifiers and be reported.
 */
export function pickIsbnSource(
  candidates: IsbnCandidates,
  source: IsbnSource,
): string | null {
  if (source !== "auto") {
    return candidates[source];
  }
  for (const field of AUTO_ORDER) {
    const value = candidates[field];
    if (value !== null && normaliseIsbn(value.replace(CONTROL, "")) !== null) {
      return value;
    }
  }
  return null;
}
