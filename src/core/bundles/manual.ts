import type { Minor } from "../money";
import type { BundleFallback, CoreLine, ProductConfig } from "../types";
import { configOf } from "./groups";
import { chooseWeights } from "./split";
import type { BundleNotes, BundleSettings } from "./types";

export interface ManualComponent {
  variantId: string;
  /** Units of this component in one bundle. */
  perBundle: number;
  included: boolean;
  price: Minor | null;
}

/** How one legacy bundle line with a manual composition will be split. */
export interface ManualPlan {
  ref: { kind: "manual"; lineId: string };
  title: string;
  line: CoreLine;
  components: ManualComponent[];
  method: BundleFallback;
  unitWeights: bigint[];
}

/**
 * The line's manual composition, or null when it has none. A line already in
 * a native group is never expanded: the platform has already split it, and
 * expanding again would count its books twice.
 */
export function manualCompositionOf(
  line: CoreLine,
  products: ReadonlyMap<string, ProductConfig>,
): { variantId: string; quantity: number }[] | null {
  if (line.group !== null) return null;
  const comps = configOf(line, products)?.bundleComponents;
  return comps && comps.length > 0 ? comps : null;
}

/**
 * Plans every manual-composition line.
 *
 * There are no recorded component prices to trust, so platform_allocation
 * means "use the fallback". That is structural rather than a guard failure,
 * so it is not noted: noting it would report every legacy bundle every month
 * and drown the fallbacks that signal a real problem.
 *
 * A component with no ProductConfig is unticked (it cannot be sent without
 * identifiers) and noted, because it means the publisher's composition names
 * a variant this store no longer knows.
 */
export function planManual(
  lines: readonly CoreLine[],
  products: ReadonlyMap<string, ProductConfig>,
  settings: BundleSettings,
  notes: BundleNotes,
): Map<string, ManualPlan> {
  const plans = new Map<string, ManualPlan>();
  for (const line of lines) {
    const comps = manualCompositionOf(line, products);
    if (comps === null) continue;

    const components = comps.map((c): ManualComponent => {
      // A fractional or non-positive count would make units meaningless and
      // weights negative; it is a settings error the edge should have caught,
      // so refuse loudly rather than send wrong units.
      if (!Number.isInteger(c.quantity) || c.quantity <= 0) {
        throw new Error(
          `Manual bundle on line ${line.id}: component ${c.variantId} has invalid quantity ${c.quantity}`,
        );
      }
      const config = products.get(c.variantId);
      if (config === undefined) {
        notes.manualComponentsMissing.push({
          lineId: line.id,
          variantId: c.variantId,
        });
      }
      return {
        variantId: c.variantId,
        perBundle: c.quantity,
        included: config?.included === true,
        price: config?.regularUnitPrice ?? null,
      };
    });

    const ref = { kind: "manual" as const, lineId: line.id };
    const method =
      settings.bundleSplit === "platform_allocation"
        ? settings.bundleFallback
        : settings.bundleSplit;
    const w = chooseWeights(
      components.map((c) => c.price),
      method,
    );
    if (w.reason !== null) {
      notes.bundleSplitFallbacks.push({
        ref,
        reason: w.reason,
        method: w.method,
      });
    }
    plans.set(line.id, {
      ref,
      title: line.title,
      line,
      components,
      method: w.method,
      unitWeights: w.unitWeights,
    });
  }
  return plans;
}
