/**
 * Integer minor units of a sale's currency (pence, yen, fils).
 *
 * A plain alias rather than a branded type: every DTO in the core is
 * written against `bigint`, and a brand would force a cast at each literal
 * and each arithmetic result, which is more noise than protection. The
 * separation that matters is bigint (money) versus number (counts such as
 * quantities); TypeScript already refuses to mix those, and the lint rules
 * ban every route from one to the other inside src/core.
 */
export type Minor = bigint;

/** A percentage scaled by PERCENT_SCALE: "12.5" → 125_000n. */
export type ScaledPercent = bigint;
