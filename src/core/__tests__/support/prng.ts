// Seeded PRNG (mulberry32) so property tests are reproducible: a failing case
// can be replayed from its seed instead of vanishing on the next run.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// Builds bigints wider than 2^53 from several draws, so tests reach values a
// float could not represent exactly.
export function randBigInt(rng: () => number, maxDigits: number): bigint {
  const digits = randInt(rng, 1, maxDigits);
  let s = "";
  for (let i = 0; i < digits; i++) s += String(randInt(rng, 0, 9));
  return BigInt(s);
}
