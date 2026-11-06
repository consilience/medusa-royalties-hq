// Bundles: turns an order into effective lines for aggregation.
// Runs around line net: computeLineNets/computeRefundNets on the real lines
// first, then bundle components are split out of the finished nets.
export { resolveBundles } from "./resolve";
export { platformGuardHolds } from "./groups";
export { detectUnknownBundleLines } from "./unknown";
export {
  applySaleContext,
  captureSaleContext,
  saleViewOf,
} from "./saleContext";
export type {
  BundleFallbackReason,
  BundleInfo,
  BundleNotes,
  BundleRef,
  BundleSettings,
  BundleSplitFallback,
  EffectiveLine,
  EffectiveRefund,
  EffectiveRefundLine,
  MissingManualComponent,
  ResolvedOrder,
  UnknownBundleLine,
} from "./types";
