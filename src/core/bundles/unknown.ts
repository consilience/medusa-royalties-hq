import type { CoreOrder, ProductConfig } from "../types";
import { configOf } from "./groups";
import { manualCompositionOf } from "./manual";
import type { UnknownBundleLine } from "./types";

/**
 * Lines that look like part of a bundle we cannot see:
 * originally priced at zero, beside priced
 * lines, with no group and no manual composition. Typical sources
 * are bundles built from line-item properties or hidden variants.
 *
 * They are reported, not guessed at. Guessing which priced line they belong
 * to could move royalty between authors; reporting lets the publisher define
 * a composition. The line itself is still processed as a normal line, so its
 * units count at zero.
 *
 * Gift cards are excluded: they are never royalty lines. The zero test is on
 * the original unit price, so a priced line that a discount took to zero is
 * a discount, not a bundle component.
 *
 * A line whose product is explicitly unticked is not reported either: it is
 * never sent and carries no revenue, so whether it belongs to a bundle
 * changes nothing, and a free unticked tote in every order would bury the
 * reports that matter. A line with no product config at all is still
 * reported: the publisher may simply not have set that product up yet.
 * `products` is the sale-time view when the order recorded one.
 */
export function detectUnknownBundleLines(
  order: Pick<CoreOrder, "lines">,
  products: ReadonlyMap<string, ProductConfig>,
): UnknownBundleLine[] {
  const lines = order.lines.filter((l) => !l.isGiftCard);
  if (!lines.some((l) => l.originalUnitPrice > 0n)) return [];
  return lines
    .filter(
      (l) =>
        l.originalUnitPrice === 0n &&
        l.group === null &&
        configOf(l, products)?.included !== false &&
        manualCompositionOf(l, products) === null,
    )
    .map((l) => ({
      lineId: l.id,
      variantId: l.variantId,
      title: l.title,
      quantity: l.quantity,
    }));
}
