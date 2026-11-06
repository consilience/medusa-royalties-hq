// RHQ's hold_back_reasons codes,
// in the words the admin page and the push emails use. Codes are for
// machines; a person reads these. Kept free of server imports so the admin
// bundle can use it too.

const HOLD_BACK_TEXT: Readonly<Record<string, string>> = {
  anomaly:
    "Its figures are far out of line with the store's recent months, or with the publisher's other e-commerce months.",
  no_baseline:
    "Royalties HQ has no imported months to compare it with yet. A new connection's months wait like this until the publisher imports one.",
  before_backfill_start:
    "It is before the connection's backfill start month in Royalties HQ.",
  duplicate_period:
    "The publisher's history from before they started using Royalties HQ may already hold this month's sales.",
};

/** One reason in words; a code this app does not know is not dropped. */
export function holdBackText(code: string): string {
  // Own keys only: RHQ's code is data, and "toString" would otherwise read
  // Object.prototype's function as the words.
  return Object.prototype.hasOwnProperty.call(HOLD_BACK_TEXT, code)
    ? HOLD_BACK_TEXT[code]!
    : "Royalties HQ asked for it to be checked; see the import in Royalties HQ.";
}

/** The stored column, read defensively: JSON written by the push step. */
export function holdBackReasonsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((r): r is string => typeof r === "string")
    : [];
}
