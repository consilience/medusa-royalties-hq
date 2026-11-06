import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDecimal } from "../../money";
import type { OrphanRefund } from "../../rows/attribution";
import type {
  CoreLine,
  CoreOrder,
  CoreRefund,
  CoreSettings,
  ProductConfig,
} from "../../types";
import { settings as baseSettings } from "./builders";

// End-to-end snapshot fixtures: hand-built CoreOrder JSON in, the expected
// PayloadV1 rows/summary out. Money in the input is a decimal string in the
// order's currency (as the order reader hands it over) and is parsed once here; the
// expected output is already wire-format strings, so it is compared as is.

export const SNAPSHOT_FIXTURE_DIR = join(__dirname, "../fixtures/snapshots");

type Json = Record<string, unknown>;

export interface SnapshotFixture {
  file: string;
  description: string;
  period: string;
  settings: CoreSettings;
  orders: CoreOrder[];
  orphanRefunds: OrphanRefund[];
  products: Map<string, ProductConfig>;
  recordedCutoffs: Map<string, string>;
  expected: {
    rows: unknown[];
    summary: Json;
    settings?: Json;
  };
}

const money = (v: unknown, currency: string, fallback = "0"): bigint =>
  parseDecimal((v as string | undefined) ?? fallback, currency);

function toLine(raw: Json, currency: string): CoreLine {
  const regular = raw.regularUnitPrice as string | undefined;
  return {
    id: raw.id as string,
    variantId: (raw.variantId as string | null | undefined) ?? null,
    productId: null,
    title: raw.title as string,
    sku: null,
    barcode: null,
    quantity: raw.quantity as number,
    originalUnitPrice: money(raw.originalUnitPrice, currency),
    discountTotal: money(raw.discountTotal, currency),
    tax: money(raw.tax, currency),
    isGiftCard: (raw.isGiftCard as boolean | undefined) ?? false,
    requiresShipping: true,
    group: (raw.group as CoreLine["group"] | undefined) ?? null,
    regularUnitPrice:
      regular === undefined ? null : parseDecimal(regular, currency),
  };
}

function toRefund(raw: Json, currency: string): CoreRefund {
  const shipping = (raw.shipping as Json | undefined) ?? {};
  return {
    id: raw.id as string,
    createdAt: raw.createdAt as string,
    lines: ((raw.lines as Json[] | undefined) ?? []).map((l) => ({
      lineId: l.lineId as string,
      quantity: l.quantity as number,
      amount: money(l.amount, currency),
      tax: money(l.tax, currency),
    })),
    shipping: {
      amount: money(shipping.amount, currency),
      tax: money(shipping.tax, currency),
    },
  };
}

function toOrder(o: Json): CoreOrder {
  const currency = o.currency as string;
  const shipping = (o.shipping as Json | undefined) ?? {};
  const fee = o.fee as { fee: string; charge: string } | null | undefined;
  return {
    id: o.id as string,
    paidAt: o.paidAt as string,
    currency,
    financialStatus:
      (o.financialStatus as CoreOrder["financialStatus"] | undefined) ?? "paid",
    test: (o.test as boolean | undefined) ?? false,
    taxesIncluded: (o.taxesIncluded as boolean | undefined) ?? false,
    lines: (o.lines as Json[]).map((l) => toLine(l, currency)),
    shipping: {
      amount: money(shipping.amount, currency),
      tax: money(shipping.tax, currency),
    },
    // Settlement-currency ratio parts, as plain integers (see the bundles
    // fixture loader): a ratio needs no currency of its own.
    fee: fee ? { fee: BigInt(fee.fee), charge: BigInt(fee.charge) } : null,
    refunds: ((o.refunds as Json[] | undefined) ?? []).map((r) =>
      toRefund(r, currency),
    ),
  };
}

export function loadSnapshotFixture(file: string): SnapshotFixture {
  const raw = JSON.parse(
    readFileSync(join(SNAPSHOT_FIXTURE_DIR, file), "utf8"),
  ) as Json;
  const settings = baseSettings(
    (raw.settings as Partial<CoreSettings> | undefined) ?? {},
  );
  const orders = ((raw.orders as Json[] | undefined) ?? []).map(toOrder);
  // Catalog prices are in the shop currency; a fixture names it per product
  // only when it differs from the first order's.
  const shopCurrency = orders[0]?.currency ?? "GBP";
  const products = new Map<string, ProductConfig>();
  for (const p of (raw.products as Json[] | undefined) ?? []) {
    const price = p.regularUnitPrice as string | undefined;
    products.set(p.variantId as string, {
      variantId: p.variantId as string,
      included: p.included as boolean,
      rhqProductId: (p.rhqProductId as string | undefined) ?? null,
      isbnSourceValue: (p.isbnSourceValue as string | undefined) ?? null,
      sku: (p.sku as string | undefined) ?? null,
      asin: (p.asin as string | undefined) ?? null,
      title: p.title as string,
      regularUnitPrice:
        price === undefined
          ? null
          : parseDecimal(price, (p.currency as string) ?? shopCurrency),
      bundleComponents:
        (p.bundleComponents as ProductConfig["bundleComponents"]) ?? null,
    });
  }
  const orphanRefunds: OrphanRefund[] = (
    (raw.orphanRefunds as Json[] | undefined) ?? []
  ).map((o) => ({
    orderId: o.orderId as string,
    currency: o.currency as string,
    refund: toRefund(o.refund as Json, o.currency as string),
  }));
  return {
    file,
    description: raw.description as string,
    period: raw.period as string,
    settings,
    orders,
    orphanRefunds,
    products,
    recordedCutoffs: new Map(
      Object.entries(
        (raw.recordedCutoffs as Record<string, string> | undefined) ?? {},
      ),
    ),
    expected: raw.expected as SnapshotFixture["expected"],
  };
}

export function snapshotFixtureFiles(): string[] {
  return readdirSync(SNAPSHOT_FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}
