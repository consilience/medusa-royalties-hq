import type { Minor } from "../money";
import type { CoreOrder, ProductConfig, SaleContext } from "../types";
import { configOf } from "./groups";
import { manualCompositionOf } from "./manual";
import type { BundleSettings } from "./types";

const BUNDLE_SPLITS: readonly string[] = [
  "platform_allocation",
  "price_ratio",
  "even",
];
const BUNDLE_FALLBACKS: readonly string[] = ["price_ratio", "even"];
const MINOR_UNITS = /^(0|[1-9]\d*)$/;

/**
 * The product configs and bundle settings an order is resolved with: the
 * ones its sale was sent with (order.saleContext, recorded by the ledger
 * from captureSaleContext) layered over the current ones.
 *
 * Why: resolution runs again every time a snapshot containing one of the
 * order's refunds is built, possibly months after the sale. Using the current
 * config there would let a refund diverge from the sale it reverses: a
 * product unticked since would drop a refund of royalty already paid, one
 * ticked since would claw back royalty never paid, and a changed split method
 * or catalog price would re-weight a bundle refund differently from its sale.
 *
 * Only inclusion, split method and regular price come from the context.
 * Identifiers and titles stay current (they say where the row goes, not how
 * much it is worth), and a variant with no current config stays unresolvable:
 * without identifiers it could not be sent anyway.
 */
export function applySaleContext(
  order: Pick<CoreOrder, "id" | "saleContext">,
  products: ReadonlyMap<string, ProductConfig>,
  settings: BundleSettings,
): { products: ReadonlyMap<string, ProductConfig>; settings: BundleSettings } {
  const ctx = order.saleContext;
  if (ctx === undefined || ctx === null) return { products, settings };

  // The context comes from stored JSON, so it is checked like any other
  // input: a bad value would otherwise split a bundle by an unknown method.
  if (!BUNDLE_SPLITS.includes(ctx.bundleSplit)) {
    throw new Error(
      `Order ${order.id}: sale-time bundle split ${JSON.stringify(ctx.bundleSplit)} is unknown`,
    );
  }
  if (!BUNDLE_FALLBACKS.includes(ctx.bundleFallback)) {
    throw new Error(
      `Order ${order.id}: sale-time bundle fallback ${JSON.stringify(ctx.bundleFallback)} is unknown`,
    );
  }

  const effective = new Map(products);
  const variants = new Set([
    ...Object.keys(ctx.included),
    ...Object.keys(ctx.regularUnitPrices),
  ]);
  for (const variantId of variants) {
    const config = products.get(variantId);
    if (config === undefined) continue;
    const included = ctx.included[variantId];
    const price = ctx.regularUnitPrices[variantId];
    effective.set(variantId, {
      ...config,
      included: included ?? config.included,
      // null is a recorded "unknown": the split fell back then, so it must
      // fall back now even if the catalog has gained a price since.
      regularUnitPrice:
        price === undefined
          ? config.regularUnitPrice
          : price === null
            ? null
            : parseMinorUnits(price, order.id, variantId),
    });
  }

  return {
    products: effective,
    settings: {
      ...settings,
      bundleSplit: ctx.bundleSplit,
      bundleFallback: ctx.bundleFallback,
    },
  };
}

// Integer minor units only: a decimal point here would mean the edge stored
// major units, and reading "12.50" as 1250 or 12 would both be wrong.
function parseMinorUnits(
  text: string,
  orderId: string,
  variantId: string,
): bigint {
  if (!MINOR_UNITS.test(text)) {
    throw new Error(
      `Order ${orderId}: sale-time regular unit price for ${variantId} must be integer minor units, got ${JSON.stringify(text)}`,
    );
  }
  return BigInt(text);
}

/**
 * What an order's sale was resolved with, as a SaleContext: the effective
 * inclusion of every variant the resolution consulted (lines, and manual
 * bundle components), the split method and fallback, and every regular unit
 * price a bundle split read. resolveBundles on the order with this context
 * gives the same lines whatever the config says later (the round-trip test
 * in tests/unit/core/bundles/saleContext.test.ts).
 *
 * Unticked and unconfigured variants are recorded as false, not left out:
 * a line that was not sent must stay unsent in its refunds, or a later tick
 * would claw back royalty the author was never paid.
 *
 * An order that already carries a context is captured through it, so a
 * frozen context comes back unchanged.
 *
 * Deliberately not captured: a manual bundle's composition, identifiers and
 * titles. Those say where a row goes, not how much it is worth.
 */
export function captureSaleContext(
  order: Pick<CoreOrder, "id" | "lines" | "saleContext">,
  currentProducts: ReadonlyMap<string, ProductConfig>,
  currentSettings: BundleSettings,
): SaleContext {
  const { products, settings } = applySaleContext(
    order,
    currentProducts,
    currentSettings,
  );
  const included: Record<string, boolean> = {};
  const note = (variantId: string) => {
    included[variantId] = products.get(variantId)?.included === true;
  };
  // Prices from the catalog (config) and from a line's own order-time price
  // are kept apart: when one variant was read both ways the catalog value is
  // the one to record, because the line's own price is in the ledger for
  // good and applySaleContext only ever replaces the catalog one.
  const fromCatalog = new Map<string, Minor | null>();
  const fromLine = new Map<string, Minor>();

  for (const line of order.lines) {
    if (line.isGiftCard || line.variantId === null) continue;
    note(line.variantId);
    const manual = manualCompositionOf(line, products);
    for (const component of manual ?? []) {
      note(component.variantId);
      fromCatalog.set(
        component.variantId,
        products.get(component.variantId)?.regularUnitPrice ?? null,
      );
    }
    if (line.group === null) continue;
    // Mirrors componentPrice(): the line's own order-time price first.
    if (line.regularUnitPrice !== null) {
      fromLine.set(line.variantId, line.regularUnitPrice);
    } else {
      fromCatalog.set(
        line.variantId,
        configOf(line, products)?.regularUnitPrice ?? null,
      );
    }
  }

  const regularUnitPrices: Record<string, string | null> = {};
  for (const [variantId, price] of fromLine) {
    regularUnitPrices[variantId] = asMinorUnits(price);
  }
  for (const [variantId, price] of fromCatalog) {
    regularUnitPrices[variantId] = asMinorUnits(price);
  }
  return {
    included,
    bundleSplit: settings.bundleSplit,
    bundleFallback: settings.bundleFallback,
    regularUnitPrices,
  };
}

// chooseWeights treats a negative price as unknown, so it is recorded as
// unknown: storing "-5" would be refused by parseMinorUnits on the way back.
function asMinorUnits(price: Minor | null): string | null {
  return price === null || price < 0n ? null : price.toString();
}

/**
 * The order as the build of its own sale period should see it: a context
 * that is not frozen is dropped, so the current config decides.
 *
 * Why: the context is recorded when a live push of the period is accepted,
 * but RHQ only stages that push. A publisher who reviews the staged import,
 * sees a product missing, ticks it and pushes the period again must get the
 * product in; applying the recorded context would send the same rows again.
 * Once frozen (the period imported, or a refund already mirrored it in
 * another period) the context is what was sent for good and applies here
 * too. Refunds of the order in other periods always use the context.
 */
export function saleViewOf<
  T extends Pick<CoreOrder, "saleContext" | "saleContextFrozen">,
>(order: T): T {
  if (order.saleContextFrozen === true || order.saleContext == null) {
    return order;
  }
  return { ...order, saleContext: null };
}
