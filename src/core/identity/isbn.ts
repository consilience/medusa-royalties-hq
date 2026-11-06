// ISBN handling for the `isbn` identifier. The rule that shapes everything
// here: RHQ checks the `isbn` column, an invalid value is a per-row error, and
// any row error rejects the whole snapshot
// (422). So this module never passes through anything it cannot prove is a
// valid ISBN-13; a doubtful value becomes null and the caller reports it.
//
// The output is always 13 bare digits: RHQ refuses a hyphenated ISBN-10
// ("0-306-40615-2"), so it is converted here.

// Formatting we are willing to remove: whitespace (including the non-breaking
// space that spreadsheets and catalogue pages paste in) and any Unicode dash,
// since an en dash between ISBN groups is common in copied text. Anything
// else (dots, slashes, an "ISBN" label) is left in place so that it fails the
// shape check below: guessing past it risks turning a SKU into an "ISBN".
const FORMATTING = /[\s\p{Pd}]/gu;

// Without the `u` flag `\d` is ASCII-only, which is what we want: full-width
// or other script digits are not something RHQ accepts either.
const ISBN_13 = /^97[89]\d{10}$/;
const ISBN_10 = /^\d{9}[\dX]$/;

// Digit value without calling Number or parseInt, which the core bans
// (they exist to keep money off floats; these are only checksum digits).
function digit(char: string): number {
  return char.charCodeAt(0) - 48;
}

/**
 * True for 13 bare ASCII digits with a 978/979 (Bookland) prefix and a
 * correct EAN-13 check digit. Formatted input is not accepted: call
 * normaliseIsbn for that.
 *
 * The prefix check matters because every EAN-13 barcode passes the same
 * checksum; only the Bookland prefix makes it an ISBN.
 */
export function isValidIsbn13(value: string): boolean {
  if (!ISBN_13.test(value)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += digit(value.charAt(i)) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10 === digit(value.charAt(12));
}

/**
 * True for 9 bare digits plus a check character (digit or upper-case X,
 * meaning 10) that satisfies the mod-11 weighted checksum.
 */
export function isValidIsbn10(value: string): boolean {
  if (!ISBN_10.test(value)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = value.charAt(i);
    sum += (char === "X" ? 10 : digit(char)) * (10 - i);
  }
  return sum % 11 === 0;
}

/**
 * Converts a valid bare ISBN-10 to its ISBN-13. Every ISBN-10 maps into the
 * 978 prefix (979 has no ISBN-10 form), and the ISBN-10 check digit is
 * dropped because the ISBN-13 one is computed over different weights.
 */
function isbn10To13(isbn10: string): string {
  const body = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += digit(body.charAt(i)) * (i % 2 === 0 ? 1 : 3);
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/**
 * Returns the value as a bare, valid ISBN-13, or null if it is not an ISBN.
 *
 * Accepts ISBN-13 or ISBN-10 (converted), with spaces and hyphens anywhere and
 * a lower-case x check digit. Null for everything else, including a perfectly
 * good EAN-13 outside 978/979: it may be a real barcode, but it is not an
 * ISBN, and RHQ would refuse it in the `isbn` column. The caller still has the
 * SKU to match on.
 */
export function normaliseIsbn(value: string): string | null {
  const bare = value.replace(FORMATTING, "").toUpperCase();
  if (isValidIsbn13(bare)) {
    return bare;
  }
  if (isValidIsbn10(bare)) {
    return isbn10To13(bare);
  }
  return null;
}
