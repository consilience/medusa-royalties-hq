import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDecimal } from "../../money";
import type {
  CoreLine,
  CoreOrder,
  CoreRefund,
  CoreSettings,
  ProductConfig,
} from "../../types";

// Fixtures hold money as decimal strings in the order's currency, as the
// order reader hands it over, and are converted here once. Keeping bigint out of JSON
// means the files stay readable and diffable against future real captures.

export const FIXTURE_DIR = join(__dirname, "../fixtures/bundles");

type Json = Record<string, unknown>;

export interface FixtureCase {
  name: string;
  settings: Partial<CoreSettings>;
  expect: {
    sales?: Json[];
    refunds?: { refundId: string; lines: Json[] }[];
    bundleSplitFallbacks?: Json[];
    unknownBundleLines?: string[];
  };
}

export interface BundleFixture {
  file: string;
  description: string;
  order: CoreOrder;
  products: Map<string, ProductConfig>;
  cases: FixtureCase[];
}

const MONEY_KEYS = new Set([
  "gross",
  "discount",
  "exTax",
  "commission",
  "fees",
  "shipping",
  "net",
  "listPriceExTax",
]);

/** Converts the money keys of an expectation object to minor units. */
export function expectedMoney(obj: Json, currency: string): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] =
      MONEY_KEYS.has(k) && typeof v === "string"
        ? parseDecimal(v, currency)
        : v;
  }
  return out;
}

function toLine(raw: Json, currency: string): CoreLine {
  const money = (k: string, fallback: string | null) => {
    const v = (raw[k] as string | undefined) ?? fallback;
    return v === null ? null : parseDecimal(v, currency);
  };
  return {
    id: raw.id as string,
    variantId: (raw.variantId as string | null | undefined) ?? null,
    productId: (raw.productId as string | null | undefined) ?? null,
    title: raw.title as string,
    sku: (raw.sku as string | null | undefined) ?? null,
    barcode: (raw.barcode as string | null | undefined) ?? null,
    quantity: raw.quantity as number,
    originalUnitPrice: money("originalUnitPrice", "0")!,
    discountTotal: money("discountTotal", "0")!,
    tax: money("tax", "0")!,
    isGiftCard: (raw.isGiftCard as boolean | undefined) ?? false,
    requiresShipping: (raw.requiresShipping as boolean | undefined) ?? true,
    group: (raw.group as CoreLine["group"] | undefined) ?? null,
    regularUnitPrice: money("regularUnitPrice", null),
  };
}

function toRefund(raw: Json, currency: string): CoreRefund {
  const shipping = (raw.shipping as { amount: string; tax: string }) ?? {
    amount: "0",
    tax: "0",
  };
  return {
    id: raw.id as string,
    createdAt: raw.createdAt as string,
    lines: (raw.lines as Json[]).map((l) => ({
      lineId: l.lineId as string,
      quantity: l.quantity as number,
      amount: parseDecimal(l.amount as string, currency),
      tax: parseDecimal(l.tax as string, currency),
    })),
    shipping: {
      amount: parseDecimal(shipping.amount, currency),
      tax: parseDecimal(shipping.tax, currency),
    },
  };
}

export function loadFixture(file: string): BundleFixture {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as Json;
  const o = raw.order as Json;
  const currency = o.currency as string;
  const shipping = (o.shipping as { amount: string; tax: string }) ?? {
    amount: "0",
    tax: "0",
  };
  const fee = o.fee as { fee: string; charge: string } | null | undefined;
  const order: CoreOrder = {
    id: o.id as string,
    paidAt: (o.paidAt as string | undefined) ?? "2026-08-10T12:00:00+01:00",
    currency,
    financialStatus:
      (o.financialStatus as CoreOrder["financialStatus"] | undefined) ?? "paid",
    test: false,
    taxesIncluded: (o.taxesIncluded as boolean | undefined) ?? false,
    lines: (o.lines as Json[]).map((l) => toLine(l, currency)),
    shipping: {
      amount: parseDecimal(shipping.amount, currency),
      tax: parseDecimal(shipping.tax, currency),
    },
    // Settlement-currency ratio parts: parsed as plain integers of cents so a
    // fixture can state them without a currency of their own.
    fee: fee ? { fee: BigInt(fee.fee), charge: BigInt(fee.charge) } : null,
    refunds: ((o.refunds as Json[] | undefined) ?? []).map((r) =>
      toRefund(r, currency),
    ),
  };
  const products = new Map<string, ProductConfig>();
  for (const p of raw.products as Json[]) {
    const price = p.regularUnitPrice as string | undefined;
    products.set(p.variantId as string, {
      variantId: p.variantId as string,
      included: p.included as boolean,
      rhqProductId: null,
      isbnSourceValue: null,
      sku: null,
      asin: null,
      title: p.title as string,
      regularUnitPrice:
        price === undefined ? null : parseDecimal(price, currency),
      bundleComponents:
        (p.bundleComponents as ProductConfig["bundleComponents"] | undefined) ??
        null,
    });
  }
  return {
    file,
    description: raw.description as string,
    order,
    products,
    cases: raw.cases as FixtureCase[],
  };
}

export function fixtureFiles(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}
