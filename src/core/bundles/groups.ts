import type { Minor } from "../money";
import type {
  BundleFallback,
  BundleSplit,
  CoreLine,
  ProductConfig,
} from "../types";
import { chooseWeights } from "./split";
import type { BundleSettings, BundleSplitFallback } from "./types";

/** How one grouped bundle (CoreLine.group; never set by the Medusa reader) will be split. */
export interface GroupPlan {
  ref: { kind: "group"; groupId: string };
  title: string;
  /** The group's non-gift-card component lines, in order-line order. */
  lines: CoreLine[];
  method: BundleSplit;
  /** Per-unit weights for a re-weighted split; null under platform allocation. */
  unitWeights: bigint[] | null;
}

/**
 * The platform-allocation guard: the recorded
 * component prices are trusted unless an included component is at zero while
 * another component is priced. That is the shape of an app that puts the
 * whole bundle price on one line, and trusting it would pay one author for
 * the whole bundle.
 *
 * Only included components count on the zero side: an unticked tote at £0 is
 * never sent, so it cannot be under-paid. Any component counts on the priced
 * side, since a priced tote beside a £0 book is exactly the harmful shape.
 *
 * The other condition, "component prices sum to the bundle's net",
 * holds by construction for grouped bundles: there is no parent line, so the bundle's
 * net *is* the sum of its components.
 *
 * `gross` (after discounts) is the price tested, so a component zeroed by a
 * 100% discount is treated like one priced at zero.
 */
export function platformGuardHolds(
  components: readonly { gross: Minor; included: boolean }[],
): boolean {
  const zeroIncluded = components.some((c) => c.included && c.gross === 0n);
  const anyPriced = components.some((c) => c.gross !== 0n);
  return !(zeroIncluded && anyPriced);
}

/**
 * Groups component lines by group id and decides each group's split.
 * `lines` must already exclude gift cards; `grossOf` gives each line's gross
 * from computeLineNets. Fallbacks are appended to `fallbacks`.
 */
export function planGroups(
  lines: readonly CoreLine[],
  grossOf: (lineId: string) => Minor,
  products: ReadonlyMap<string, ProductConfig>,
  settings: BundleSettings,
  fallbacks: BundleSplitFallback[],
): Map<string, GroupPlan> {
  const byGroup = new Map<string, CoreLine[]>();
  for (const l of lines) {
    if (l.group === null) continue;
    const members = byGroup.get(l.group.id);
    if (members) members.push(l);
    else byGroup.set(l.group.id, [l]);
  }

  const plans = new Map<string, GroupPlan>();
  for (const [groupId, members] of byGroup) {
    const ref = { kind: "group" as const, groupId };
    const title = members[0]!.group!.title;

    let method: BundleFallback;
    let guardFailed = false;
    if (settings.bundleSplit === "platform_allocation") {
      const holds = platformGuardHolds(
        members.map((l) => ({
          gross: grossOf(l.id),
          included: configOf(l, products)?.included === true,
        })),
      );
      if (holds) {
        plans.set(groupId, {
          ref,
          title,
          lines: members,
          method: "platform_allocation",
          unitWeights: null,
        });
        continue;
      }
      method = settings.bundleFallback;
      guardFailed = true;
    } else {
      method = settings.bundleSplit;
    }

    // Order-time price first (no drift), then the current catalog price
    // (the documented source of drift). The line's own
    // originalUnitPrice is never used: it is the figure being
    // distrusted.
    const w = chooseWeights(
      members.map((l) => componentPrice(l, products)),
      method,
    );
    // Both notes carry the method finally used, which for a guard failure
    // may itself have fallen back from price_ratio to quantity.
    if (guardFailed) {
      fallbacks.push({
        ref,
        reason: "zero_priced_component",
        method: w.method,
      });
    }
    if (w.reason !== null) {
      fallbacks.push({ ref, reason: w.reason, method: w.method });
    }
    plans.set(groupId, {
      ref,
      title,
      lines: members,
      method: w.method,
      unitWeights: w.unitWeights,
    });
  }
  return plans;
}

export function configOf(
  line: CoreLine,
  products: ReadonlyMap<string, ProductConfig>,
): ProductConfig | undefined {
  return line.variantId === null ? undefined : products.get(line.variantId);
}

/** Regular unit price of a grouped bundle component, or null when unknown. */
export function componentPrice(
  line: CoreLine,
  products: ReadonlyMap<string, ProductConfig>,
): Minor | null {
  return (
    line.regularUnitPrice ?? configOf(line, products)?.regularUnitPrice ?? null
  );
}
