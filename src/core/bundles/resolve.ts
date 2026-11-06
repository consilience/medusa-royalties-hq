import type { Minor } from "../money";
import { computeLineNets, type LineNet } from "../rows/lineNet";
import { computeRefundNets, type RefundLineNet } from "../rows/refundNet";
import type { CoreLine, CoreOrder, CoreRefund, ProductConfig } from "../types";
import { componentPrice, configOf, planGroups, type GroupPlan } from "./groups";
import { planManual, type ManualPlan } from "./manual";
import {
  firstUsable,
  listPriceExTax,
  poolOf,
  scaleWeights,
  splitPool,
} from "./split";
import type {
  BundleInfo,
  BundleNotes,
  BundleSettings,
  EffectiveLine,
  EffectiveRefund,
  EffectiveRefundLine,
  ResolvedOrder,
} from "./types";
import { applySaleContext } from "./saleContext";
import { detectUnknownBundleLines } from "./unknown";

const SALE_KEYS = [
  "gross",
  "discount",
  "exTax",
  "commission",
  "fees",
  "shipping",
] as const;
const REFUND_KEYS = [
  "gross",
  "exTax",
  "commission",
  "fees",
  "shipping",
] as const;

type SaleMoney = Record<(typeof SALE_KEYS)[number], Minor>;
type RefundMoney = Record<(typeof REFUND_KEYS)[number], Minor>;

/**
 * Turns one order into the lines aggregation should count:
 * bundle components split out, legacy bundles expanded
 * into their components, and everything else passed through unchanged.
 *
 * Pure: the order, the store's product configs (keyed by variant id) and the
 * settings in; effective sale lines, effective refund lines per refund, and
 * the notes the summary needs out.
 *
 * **Why the split is applied to the finished line nets, not to ex-tax before
 * deductions.** Line net (tax, commission, fees, shipping) runs first on the
 * real order lines, exactly as for an order with no bundle; each money field
 * of a bundle is then pooled and re-split with largest remainder by one set
 * of weights. So:
 *
 * - every field of a bundle's parts sums exactly to the same field over its
 *   real lines, and the order's totals are identical whichever split method
 *   is chosen. Splitting ex-tax first and deducting per component would
 *   re-round commission per component, so merely switching price_ratio to
 *   even could change the order's total commission by a penny;
 * - a refund's real lines go through computeRefundNets, which mirrors the
 *   sale line by line, and are then pooled and split by the sale's weights.
 *   allocateLargestRemainder is symmetric about zero, so a full refund of a
 *   bundle reverses each component's sale exactly.
 *
 * Unticked components take part in every split and come back with
 * `included: false`; the caller counts them as unticked revenue and never
 * sends them. Bundle-derived lines stay separate effective lines
 * with `bundle` set; aggregation merges them into the component's ordinary
 * row (no bundle row).
 */
export function resolveBundles(
  order: CoreOrder,
  currentProducts: ReadonlyMap<string, ProductConfig>,
  currentSettings: BundleSettings,
): ResolvedOrder {
  // Sale and refunds are resolved from one plan with one set of configs, so
  // layering the sale-time context here makes every refund mirror its sale.
  const { products, settings } = applySaleContext(
    order,
    currentProducts,
    currentSettings,
  );
  const notes: BundleNotes = {
    bundleSplitFallbacks: [],
    unknownBundleLines: [],
    manualComponentsMissing: [],
  };
  // Gift cards are dropped before anything else, as in computeLineNets:
  // they are never royalty lines and must not become bundle components.
  const lines = order.lines.filter((l) => !l.isGiftCard);
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const saleNets = computeLineNets(order, settings);
  const netById = new Map(saleNets.lines.map((n) => [n.lineId, n]));
  const netOf = (id: string): LineNet => netById.get(id)!;

  const groups = planGroups(
    lines,
    (id) => netOf(id).gross,
    products,
    settings,
    notes.bundleSplitFallbacks,
  );
  const manuals = planManual(lines, products, settings, notes);
  notes.unknownBundleLines = detectUnknownBundleLines(order, products);

  const orderRatio = { exTax: 0n, gross: 0n };
  for (const n of saleNets.lines) {
    orderRatio.exTax += n.exTax;
    orderRatio.gross += n.gross;
  }

  const ctx: Context = {
    taxesIncluded: order.taxesIncluded,
    orderRatio,
    products,
    groups,
    manuals,
    lineById,
  };

  const split = new Map<string, EffectiveLine[]>();
  for (const plan of groups.values()) {
    for (const [id, eff] of splitGroupSale(plan, netOf, ctx)) {
      split.set(id, [eff]);
    }
  }
  for (const plan of manuals.values()) {
    split.set(plan.line.id, splitManualSale(plan, netOf(plan.line.id), ctx));
  }
  const saleLines = lines.flatMap(
    (l) => split.get(l.id) ?? [plainSale(l, netOf(l.id), ctx)],
  );

  return {
    orderId: order.id,
    sale: {
      lines: saleLines,
      feeFallback: saleNets.feeFallback,
      flatFeeMissing: saleNets.flatFeeMissing,
      unallocatedShipping: saleNets.unallocatedShipping,
      netsClamped: saleNets.netsClamped,
    },
    refunds: order.refunds.map((r) => resolveRefund(order, r, settings, ctx)),
    notes,
  };
}

interface Context {
  taxesIncluded: boolean;
  /** Σ exTax and Σ gross over the order's non-gift-card lines: the tax ratio for a source with none of its own. */
  orderRatio: { exTax: Minor; gross: Minor };
  products: ReadonlyMap<string, ProductConfig>;
  groups: Map<string, GroupPlan>;
  manuals: Map<string, ManualPlan>;
  lineById: Map<string, CoreLine>;
}

const isIncluded = (l: CoreLine, ctx: Context) =>
  configOf(l, ctx.products)?.included === true;

function withNet<T extends RefundMoney>(m: T): T & { net: Minor } {
  return { ...m, net: m.exTax - m.commission - m.fees + m.shipping };
}

function saleMoney(n: LineNet): SaleMoney {
  return {
    gross: n.gross,
    discount: n.discount,
    exTax: n.exTax,
    commission: n.commission,
    fees: n.fees,
    shipping: n.shipping,
  };
}

function refundMoney(n: RefundLineNet): RefundMoney {
  return {
    gross: n.gross,
    exTax: n.exTax,
    commission: n.commission,
    fees: n.fees,
    shipping: n.shipping,
  };
}

function plainSale(l: CoreLine, n: LineNet, ctx: Context): EffectiveLine {
  return {
    lineId: l.id,
    sourceLineIds: [l.id],
    variantId: l.variantId,
    quantity: l.quantity,
    ...withNet(saleMoney(n)),
    // An ordinary line's own pre-discount price is the order-time price, so
    // it beats the current catalog price.
    listPriceExTax: listPriceExTax(
      l.regularUnitPrice ?? l.originalUnitPrice,
      n.exTax,
      n.gross,
      ctx.taxesIncluded,
      ctx.orderRatio,
    ),
    included: isIncluded(l, ctx),
    bundle: null,
  };
}

function groupInfo(plan: GroupPlan): BundleInfo {
  return { ref: plan.ref, method: plan.method, title: plan.title };
}

function splitGroupSale(
  plan: GroupPlan,
  netOf: (id: string) => LineNet,
  ctx: Context,
): [string, EffectiveLine][] {
  const nets = plan.lines.map((l) => netOf(l.id));
  const pool = poolOf(nets.map(saleMoney), SALE_KEYS);
  const info = groupInfo(plan);
  // The bundle was taxed as a whole, so the group's own exTax ÷ gross strips
  // tax from every component's list price, including a £0 one.
  const listPrice = (l: CoreLine) =>
    listPriceExTax(
      componentPrice(l, ctx.products),
      pool.exTax,
      pool.gross,
      ctx.taxesIncluded,
      ctx.orderRatio,
    );

  if (plan.unitWeights === null) {
    return plan.lines.map((l, i) => [
      l.id,
      {
        lineId: l.id,
        sourceLineIds: [l.id],
        variantId: l.variantId,
        quantity: l.quantity,
        ...withNet(saleMoney(nets[i]!)),
        listPriceExTax: listPrice(l),
        included: isIncluded(l, ctx),
        bundle: info,
      },
    ]);
  }

  const weights = firstUsable(
    scaleWeights(
      plan.unitWeights,
      plan.lines.map((l) => l.quantity),
    ),
    plan.unitWeights,
  );
  const parts = splitPool(pool, SALE_KEYS, weights);
  const sourceLineIds = plan.lines.map((l) => l.id);
  return plan.lines.map((l, i) => [
    l.id,
    {
      lineId: l.id,
      sourceLineIds,
      variantId: l.variantId,
      quantity: l.quantity,
      ...withNet(parts[i]!),
      listPriceExTax: listPrice(l),
      included: isIncluded(l, ctx),
      bundle: info,
    },
  ]);
}

// Weights for a manual bundle: unit weight × units per bundle. The line's
// quantity is a common factor of every component, so leaving it out gives
// the same split and lets a refund of any quantity re-use the sale's weights.
function manualWeights(plan: ManualPlan): bigint[] {
  return firstUsable(
    scaleWeights(
      plan.unitWeights,
      plan.components.map((c) => c.perBundle),
    ),
    plan.components.map((c) => BigInt(c.perBundle)),
  );
}

function manualInfo(plan: ManualPlan): BundleInfo {
  return { ref: plan.ref, method: plan.method, title: plan.title };
}

function splitManualSale(
  plan: ManualPlan,
  n: LineNet,
  ctx: Context,
): EffectiveLine[] {
  const parts = splitPool(saleMoney(n), SALE_KEYS, manualWeights(plan));
  const info = manualInfo(plan);
  return plan.components.map((c, i) => ({
    lineId: plan.line.id,
    sourceLineIds: [plan.line.id],
    variantId: c.variantId,
    quantity: c.perBundle * plan.line.quantity,
    ...withNet(parts[i]!),
    // The bundle line's own exTax ÷ gross strips its recorded tax from the
    // component's catalog price, which is on the same tax basis.
    listPriceExTax: listPriceExTax(
      c.price,
      n.exTax,
      n.gross,
      ctx.taxesIncluded,
      ctx.orderRatio,
    ),
    included: c.included,
    bundle: info,
  }));
}

function resolveRefund(
  order: CoreOrder,
  refund: CoreRefund,
  settings: BundleSettings,
  ctx: Context,
): EffectiveRefund {
  const nets = computeRefundNets(order, refund, settings);
  const out: EffectiveRefundLine[] = [];
  const doneGroups = new Set<string>();

  for (const r of nets.lines) {
    // computeRefundNets has already thrown on a line not on the order and
    // dropped gift cards, so every remaining line is known.
    const line = ctx.lineById.get(r.lineId)!;

    const manual = ctx.manuals.get(line.id);
    if (manual) {
      out.push(...splitManualRefund(manual, r, ctx));
      continue;
    }

    const plan = line.group ? ctx.groups.get(line.group.id) : undefined;
    if (plan === undefined) {
      out.push(passThroughRefund(line, r, null, ctx));
      continue;
    }
    if (plan.unitWeights === null) {
      // Platform allocation: each component's refund stays with it
      // just as its sale did.
      out.push(passThroughRefund(line, r, groupInfo(plan), ctx));
      continue;
    }
    if (doneGroups.has(plan.ref.groupId)) continue;
    doneGroups.add(plan.ref.groupId);
    const members = nets.lines.filter(
      (x) => ctx.lineById.get(x.lineId)!.group?.id === plan.ref.groupId,
    );
    out.push(...splitGroupRefund(plan, plan.unitWeights, members, ctx));
  }

  return {
    refundId: refund.id,
    createdAt: refund.createdAt,
    lines: out,
    feeFallback: nets.feeFallback,
    flatFeeMissing: nets.flatFeeMissing,
    unallocatedShipping: nets.unallocatedShipping,
    netsClamped: nets.netsClamped,
  };
}

/**
 * A refund line's list price (EffectiveRefundLine.listPriceExTax), left off
 * when none is recorded so a refund line keeps its old shape then.
 */
function refundListPrice(...args: Parameters<typeof listPriceExTax>): {
  listPriceExTax?: Minor;
} {
  const price = listPriceExTax(...args);
  return price === null ? {} : { listPriceExTax: price };
}

function passThroughRefund(
  line: CoreLine,
  r: RefundLineNet,
  bundle: BundleInfo | null,
  ctx: Context,
): EffectiveRefundLine {
  return {
    lineId: line.id,
    sourceLineIds: [line.id],
    variantId: line.variantId,
    units: r.units,
    ...withNet(refundMoney(r)),
    // The line's own recorded price only, never today's catalog price: a
    // sale context records only the prices bundle splits read, so a catalog
    // price here would let a re-push of the refund's month change with the
    // catalog.
    ...refundListPrice(
      line.regularUnitPrice,
      r.exTax,
      r.gross,
      ctx.taxesIncluded,
      ctx.orderRatio,
    ),
    included: isIncluded(line, ctx),
    bundle,
  };
}

/**
 * A re-weighted bundle's refund: the money refunded on
 * any of its components in this refund is pooled and allocated to the
 * refunded components by unit weight × refunded quantity, and units follow
 * the refunded quantities. Pooling matters because under a re-weighted split
 * the platform's per-component refund amounts carry the same distrusted
 * pricing as its per-component sale amounts.
 *
 * Money refunded with no quantity (a goodwill or price-adjustment refund) has
 * no components to follow, so it is spread over every component by the sale
 * weights, with zero units, mirroring the "otherwise" case of the re-weighting rule.
 */
function splitGroupRefund(
  plan: GroupPlan,
  unitWeights: bigint[],
  members: readonly RefundLineNet[],
  ctx: Context,
): EffectiveRefundLine[] {
  const refundedQty = new Map<string, number>();
  for (const m of members) {
    refundedQty.set(m.lineId, (refundedQty.get(m.lineId) ?? 0) + m.units);
  }
  const pool = poolOf(members.map(refundMoney), REFUND_KEYS);
  const info = groupInfo(plan);
  const sourceLineIds = plan.lines
    .map((l) => l.id)
    .filter((id) => refundedQty.has(id));

  const refunded = plan.lines
    .map((l, i) => ({ l, unit: unitWeights[i]! }))
    .filter(({ l }) => (refundedQty.get(l.id) ?? 0) > 0);
  const byRefundedQty = refunded.map(
    ({ l, unit }) => unit * BigInt(refundedQty.get(l.id)!),
  );

  let targets: CoreLine[];
  let weights: bigint[];
  if (byRefundedQty.some((w) => w > 0n)) {
    targets = refunded.map(({ l }) => l);
    weights = byRefundedQty;
  } else {
    targets = plan.lines;
    weights = firstUsable(
      scaleWeights(
        unitWeights,
        plan.lines.map((l) => l.quantity),
      ),
      unitWeights,
    );
  }

  const parts = splitPool(pool, REFUND_KEYS, weights);
  return targets.map((l, i) => ({
    lineId: l.id,
    sourceLineIds,
    variantId: l.variantId,
    units: refundedQty.get(l.id) ?? 0,
    ...withNet(parts[i]!),
    // The group's own exTax ÷ gross, as on the sale side.
    ...refundListPrice(
      componentPrice(l, ctx.products),
      pool.exTax,
      pool.gross,
      ctx.taxesIncluded,
      ctx.orderRatio,
    ),
    included: isIncluded(l, ctx),
    bundle: info,
  }));
}

/**
 * A manual bundle's refund: the refunded amount is split over the virtual
 * components by the sale's weights, and each component's units are its
 * quantity per bundle × the refunded bundle quantity.
 */
function splitManualRefund(
  plan: ManualPlan,
  r: RefundLineNet,
  ctx: Context,
): EffectiveRefundLine[] {
  const parts = splitPool(refundMoney(r), REFUND_KEYS, manualWeights(plan));
  const info = manualInfo(plan);
  return plan.components.map((c, i) => ({
    lineId: plan.line.id,
    sourceLineIds: [plan.line.id],
    variantId: c.variantId,
    units: c.perBundle * r.units,
    ...withNet(parts[i]!),
    ...refundListPrice(
      c.price,
      r.exTax,
      r.gross,
      ctx.taxesIncluded,
      ctx.orderRatio,
    ),
    included: c.included,
    bundle: info,
  }));
}
