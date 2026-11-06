/**
 * Per-store push-time jitter to spread the push time.
 *
 * Every store defaults to pushing on the 15th; without a spread they would all
 * hit RHQ in the same minute. Each store therefore gets a fixed minute between
 * 01:00 and 05:59 after its cut-off, derived from a stable store key that
 * the edge supplies.
 *
 * Why a hash and not a random number: the minute must be the same on every
 * run and every server (no stored state needed, and re-deploys don't reshuffle
 * stores), and the core may not use randomness or clocks.
 *
 * Why FNV-1a and not SHA-256: nothing here is adversarial. A store gains
 * nothing by choosing its key to land on a particular minute, so all we
 * need is a stable, well-spread mapping, and it must give the same minute as
 * other implementations of the same hash. FNV-1a
 * is spread poorly in its low bits for near-identical inputs ("store-1",
 * "store-2"), so its output goes through MurmurHash3's 32-bit finaliser before
 * the modulo.
 *
 * Changing any of this moves every store's push minute, which is harmless but
 * visible; a test pins one value so it is never changed by accident.
 */

/** The window starts an hour after the cut-off (01:00 local). */
export const JITTER_BASE_MINUTES = 60;
/** Five hours of distinct minutes: 01:00 to 05:59 local. */
export const JITTER_SPAN_MINUTES = 300;

// 32-bit multiply without Math.imul (the core bans Math.*) or floats past
// 2^53: split `b` into 16-bit halves so each partial product stays exact,
// then let `>>> 0` reduce modulo 2^32.
function mul32(a: number, b: number): number {
  const lo = a * (b & 0xffff);
  const hi = ((a * (b >>> 16)) & 0xffff) << 16;
  return (lo + hi) >>> 0;
}

/** FNV-1a, 32-bit, over the UTF-8 bytes of `s`. */
export function fnv1a32(s: string): number {
  // UTF-8, not UTF-16 code units, so the value matches FNV-1a implementations
  // in other languages for non-ASCII keys.
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h = mul32((h ^ b) >>> 0, 0x01000193);
  }
  return h;
}

// MurmurHash3 fmix32: every input bit affects every output bit, so sequential
// keys don't cluster in the low bits the modulo reads.
function fmix32(h: number): number {
  let x = h >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = mul32(x, 0x85ebca6b);
  x = (x ^ (x >>> 13)) >>> 0;
  x = mul32(x, 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Minutes after the cut-off at which this store pushes: 60 to 359.
 *
 * The key is trimmed and lower-cased first because it may be a host name,
 * which is case-insensitive, and may arrive from different sources; the same
 * store must always get the same minute.
 */
export function pushOffsetMinutes(storeKey: string): number {
  const key = storeKey.trim().toLowerCase();
  if (key === "") {
    throw new Error("pushOffsetMinutes: store key is empty");
  }
  return JITTER_BASE_MINUTES + (fmix32(fnv1a32(key)) % JITTER_SPAN_MINUTES);
}
