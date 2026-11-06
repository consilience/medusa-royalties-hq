import type { RhqSnapshot } from "./client";

// RHQ's own view of a staged month's import (GET /sales-snapshots/{period}),
// reduced to what the admin page may keep and show.
//
// Why this exists: when committing a staged snapshot fails inside RHQ, RHQ
// keeps it staged with the same import id (so it can be retried or deleted
// there) and reports the failure only through the snapshot's `errors`. The
// plugin's pushes cannot help (the same bytes get "unchanged"), so the
// only useful thing it can do is say so, loudly, on the admin page.
//
// Kept free of server imports (the type import above is erased) so the
// rules can be unit tested and shared without pulling in the client.

/** Enough for a sentence of context; the full text lives in RHQ. */
export const SUMMARY_MAX_CHARS = 300;

// C0 and C1 controls, plus zero-width and bidirectional overrides: RHQ's
// message may carry anything, and a direction override could make the line read as
// something it is not. Tested by code point rather than a regex literal of
// the raw characters, which lint (rightly) treats as a likely typo.
function isUnsafeChar(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * One line of RHQ's text, safe to store and print: controls removed,
 * whitespace folded, cut at SUMMARY_MAX_CHARS. HTML is deliberately left
 * alone, never decoded or stripped: the page renders it as text, and
 * decoding entities here is what would turn text into markup.
 */
export function sanitiseRhqMessage(text: string): string | null {
  // Controls become spaces rather than vanishing, so "a\nb" stays two words.
  const line = Array.from(text, (c) =>
    isUnsafeChar(c.codePointAt(0)!) ? " " : c,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (line === "") return null;
  // Array.from counts code points, so the cut never splits a surrogate pair.
  const chars = Array.from(line);
  if (chars.length <= SUMMARY_MAX_CHARS) return line;
  return `${chars
    .slice(0, SUMMARY_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

// A reason is a code the page branches on, never text it shows.
const REASON = /^[a-z0-9_]{1,64}$/;

export interface ImportErrorSummary {
  /** RHQ's counts.errors; null when never checked. */
  count: number | null;
  summary: string | null;
  reason: string | null;
}

export function summariseImportErrors(
  snapshot: Pick<RhqSnapshot, "counts" | "errorEntries">,
): ImportErrorSummary {
  const entries = snapshot.errorEntries;
  // A coded entry says what kind of failure this is, which is what the page
  // words its warning by, so it wins over a row message listed before it.
  const coded = entries.find((e) => e.reason !== null && REASON.test(e.reason));
  const first = coded ?? entries[0];
  return {
    count: snapshot.counts.errors,
    summary: first ? sanitiseRhqMessage(first.message) : null,
    reason: coded?.reason ?? null,
  };
}

/** How RHQ's message starts for a failed commit that carries no reason code. */
const IMPORT_FAILED_PREFIX = "Unexpected error while importing";

/**
 * What the admin page should say: "import_failed" (RHQ could not commit
 * the import; only Retry or delete in RHQ helps), "errors" (some other
 * reported error), or null (nothing to warn about). A failed commit is
 * recognised by its reason code or, without one, by its message.
 */
export function importProblemKind(
  errors: ImportErrorSummary,
): "import_failed" | "errors" | null {
  if (errors.count === null || errors.count <= 0) return null;
  if (
    errors.reason === "import_failed" ||
    errors.summary?.startsWith(IMPORT_FAILED_PREFIX)
  ) {
    return "import_failed";
  }
  return "errors";
}
