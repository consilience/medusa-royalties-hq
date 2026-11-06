import { resolveBundles } from "../../bundles";
import { computeLineNets } from "../../rows/lineNet";
import { computeRefundNets } from "../../rows/refundNet";
import type {
  BundleSplit,
  CoreLine,
  CoreOrder,
  CoreRefund,
  ProductConfig,
} from "../../types";
import { mulberry32, randBigInt, randInt } from "../../__tests__/support/prng";
import { settings } from "../../__tests__/support/builders";

// For random bundle orders under every split method and fallback, every
// money field of the effective lines must sum exactly to the same field over
// the real lines they came from, per sale and per refund. This is the
// guarantee that splitting a bundle never creates or loses a minor unit.

const FIELDS = [
  "gross",
  "exTax",
  "commission",
  "fees",
  "shipping",
  "net",
] as const;
const METHODS: BundleSplit[] = ["platform_allocation", "price_ratio", "even"];
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

function randomOrder(rng: () => number, seed: number) {
  const products = new Map<string, ProductConfig>();
  const lines: CoreLine[] = [];
  const taxesIncluded = rng() < 0.5;
  const groupCount = randInt(rng, 1, 3);
  let n = 0;
  const addProduct = (
    variantId: string,
    bundle: ProductConfig["bundleComponents"],
  ) => {
    if (rng() < 0.1) return; // some variants have no config at all
    products.set(variantId, {
      variantId,
      included: rng() < 0.8,
      rhqProductId: null,
      isbnSourceValue: null,
      sku: null,
      asin: null,
      title: variantId,
      regularUnitPrice:
        rng() < 0.15 ? null : rng() < 0.1 ? 0n : randBigInt(rng, 5),
      bundleComponents: bundle,
    });
  };
  const newLine = (group: CoreLine["group"], variantId: string): CoreLine => {
    n += 1;
    const quantity = randInt(rng, 1, 5);
    const unit = rng() < 0.25 ? 0n : randBigInt(rng, 5);
    const gross = unit * BigInt(quantity);
    const discount =
      rng() < 0.3 && gross > 0n ? gross / BigInt(randInt(rng, 2, 10)) : 0n;
    const tax = rng() < 0.6 ? (gross - discount) / 6n : 0n;
    return {
      id: `L${seed}-${n}`,
      variantId,
      productId: null,
      title: `Line ${n}`,
      sku: null,
      barcode: null,
      quantity,
      originalUnitPrice: unit,
      discountTotal: discount,
      tax,
      isGiftCard: rng() < 0.05,
      requiresShipping: true,
      group,
      regularUnitPrice: rng() < 0.5 ? randBigInt(rng, 5) : null,
    };
  };

  for (let g = 0; g < groupCount; g++) {
    const kind = rng();
    if (kind < 0.6) {
      const group = {
        id: `G${g}`,
        title: `Group ${g}`,
        quantity: 1,
        variantId: null,
      };
      const size = randInt(rng, 1, 5);
      for (let i = 0; i < size; i++) {
        const v = `V${seed}-${g}-${i}`;
        addProduct(v, null);
        lines.push(newLine(group, v));
      }
    } else if (kind < 0.85) {
      const v = `M${seed}-${g}`;
      const comps = Array.from({ length: randInt(rng, 1, 4) }, (_, i) => ({
        variantId: `C${seed}-${g}-${i}`,
        quantity: randInt(rng, 1, 3),
      }));
      for (const c of comps) addProduct(c.variantId, null);
      products.set(v, {
        variantId: v,
        included: false,
        rhqProductId: null,
        isbnSourceValue: null,
        sku: null,
        asin: null,
        title: v,
        regularUnitPrice: null,
        bundleComponents: comps,
      });
      lines.push(newLine(null, v));
    } else {
      const v = `P${seed}-${g}`;
      addProduct(v, null);
      lines.push(newLine(null, v));
    }
  }

  const refunds: CoreRefund[] = [];
  for (let r = 0; r < randInt(rng, 0, 2); r++) {
    const refundLines = lines
      .filter(() => rng() < 0.5)
      .map((l) => {
        const q = randInt(rng, 0, l.quantity);
        const lineGross =
          l.originalUnitPrice * BigInt(l.quantity) - l.discountTotal;
        const amount =
          l.quantity === 0 ? 0n : (lineGross * BigInt(q)) / BigInt(l.quantity);
        const tax =
          l.quantity === 0 ? 0n : (l.tax * BigInt(q)) / BigInt(l.quantity);
        return { lineId: l.id, quantity: q, amount, tax };
      });
    refunds.push({
      id: `R${r}`,
      createdAt: "2026-08-20T00:00:00Z",
      lines: refundLines,
      shipping: { amount: rng() < 0.3 ? randBigInt(rng, 3) : 0n, tax: 0n },
    });
  }

  const order: CoreOrder = {
    id: `O${seed}`,
    paidAt: "2026-08-10T12:00:00+01:00",
    currency: "GBP",
    financialStatus: "paid",
    test: false,
    taxesIncluded,
    lines,
    shipping: { amount: rng() < 0.5 ? randBigInt(rng, 4) : 0n, tax: 0n },
    fee:
      rng() < 0.5
        ? { fee: randBigInt(rng, 3), charge: 1000n + randBigInt(rng, 5) }
        : null,
    refunds,
  };
  return { order, products };
}

describe("resolveBundles (property)", () => {
  it("preserves every money total under every split method", () => {
    const rng = mulberry32(51);
    for (let i = 0; i < 600; i++) {
      const { order, products } = randomOrder(rng, i);
      const base = {
        commissionPercent: rng() < 0.5 ? "12.5" : null,
        cardFeeMode: (["none", "flat", "actual"] as const)[randInt(rng, 0, 2)]!,
        flatFeePercent: "2.9",
        commissionExcludesFeesConfirmed: true,
        includeShipping: rng() < 0.5,
      };
      for (const bundleSplit of METHODS) {
        for (const bundleFallback of ["price_ratio", "even"] as const) {
          const s = settings({ ...base, bundleSplit, bundleFallback });
          const result = resolveBundles(order, products, s);
          const nets = computeLineNets(order, s).lines;

          for (const k of FIELDS) {
            expect(sum(result.sale.lines.map((l) => l[k]))).toBe(
              sum(nets.map((l) => l[k])),
            );
          }
          // Units are conserved too, counting a manual bundle's virtual lines.
          const soldUnits = order.lines
            .filter((l) => !l.isGiftCard)
            .reduce((a, l) => {
              const comps = products.get(l.variantId!)?.bundleComponents;
              return (
                a +
                (l.group === null && comps && comps.length > 0
                  ? comps.reduce((c, x) => c + x.quantity, 0) * l.quantity
                  : l.quantity)
              );
            }, 0);
          expect(result.sale.lines.reduce((a, l) => a + l.quantity, 0)).toBe(
            soldUnits,
          );
          for (const l of result.sale.lines) {
            expect(l.net).toBe(l.exTax - l.commission - l.fees + l.shipping);
          }

          expect(result.refunds).toHaveLength(order.refunds.length);
          order.refunds.forEach((r, ri) => {
            const rn = computeRefundNets(order, r, s).lines;
            const eff = result.refunds[ri]!.lines;
            for (const k of FIELDS) {
              expect(sum(eff.map((l) => l[k]))).toBe(sum(rn.map((l) => l[k])));
            }
            for (const l of eff) {
              expect(l.net).toBe(l.exTax - l.commission - l.fees + l.shipping);
            }
          });
        }
      }
    }
  });
});
