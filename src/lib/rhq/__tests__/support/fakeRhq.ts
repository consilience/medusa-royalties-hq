import { gunzipSync } from "node:zlib";


import { canonicalJson } from "../../../../core/payload";
import type { RhqFetch } from "../../client";
import { answerErrors, payloadErrors } from "../../../../core/__tests__/support/wireChecks";

// Answers in the shape RHQ sends, with its fixed titles and details.

export const BASE = "https://acme.royaltieshq.com/api/v1";
export const LIVE_TOKEN = `rhq_live_${"a".repeat(40)}ABCD1234`;
export const TEST_TOKEN = `rhq_test_${"b".repeat(40)}WXYZ9876`;

export function connectionBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: {
      id: 7,
      name: "Acme Press Medusa",
      platform: "medusa",
      marketplace: "Acme Shop",
      currency: "GBP",
      royalty_period_months: 6,
      royalty_period_start: 1,
      backfill_start_month: "2026-01",
      token: { mode: "live", expires_at: "2027-09-01T00:00:00Z" },
      periods: [
        {
          period: "2026-07",
          status: "imported",
          refund_cutoff_at: "2026-08-15T00:00:00Z",
          import_id: 311,
        },
        {
          period: "2026-08",
          status: "staged",
          refund_cutoff_at: "2026-09-14T23:00:00Z",
          import_id: 342,
        },
      ],
      auto_import: true,
      store: { bound: false },
      api: {
        features: ["store_id", "gzip"],
        limits: {
          max_rows: 5000,
          max_body_bytes: 5242880,
          max_inflated_body_bytes: 5242880,
          max_json_values: 220000,
          max_json_containers: 22500,
          rows_per_day: 100000,
          writes_per_minute: 30,
          writes_per_day: 1000,
          reads_per_minute: 120,
        },
      },
      ...overrides,
    },
  };
}

export function snapshotData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    period: "2026-08",
    status: "staged",
    rejection_code: null,
    import_id: 342,
    refund_cutoff_at: "2026-09-14T23:00:00Z",
    received_at: "2026-09-15T02:13:08Z",
    payload_sha256: "a".repeat(64),
    counts: { rows: 2, errors: 0, warnings: 0 },
    errors: {},
    hold_back_reasons: [],
    links: {
      self: `${BASE}/sales-snapshots/2026-08`,
      import: "https://acme.royaltieshq.com/imports/342",
    },
    ...overrides,
  };
}

export function problemBody(
  status: number,
  code: string,
  title: string,
  detail: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: `urn:royaltieshq:problem:${code}`,
    title,
    status,
    code,
    detail,
    ...extra,
  };
}

/** RHQ's words for each fixed problem. */
export const PROBLEMS = {
  unauthenticated: () =>
    problemBody(
      401,
      "unauthenticated",
      "Authentication required.",
      "Send a valid, unexpired API token as a Bearer token in the Authorization header.",
    ),
  forbidden: () =>
    problemBody(
      403,
      "forbidden",
      "This token is not allowed to do that.",
      null,
    ),
  httpsRequired: () =>
    problemBody(
      403,
      "https_required",
      "HTTPS is required.",
      "The Royalties HQ API only accepts HTTPS. This request was sent over plain HTTP, so treat the token it carried as exposed and rotate it.",
    ),
  periodCommitted: () =>
    problemBody(
      409,
      "period_committed",
      "This period has already been imported.",
      "2026-08 was imported on 20 Sep 2026. Undo that import in Royalties HQ to push it again.",
      { import_id: 342 },
    ),
  inProgress: () =>
    problemBody(
      409,
      "snapshot_in_progress",
      "This period is being processed.",
      "2026-08 is being imported. Push the same body again after Retry-After seconds.",
      { import_id: 342 },
    ),
  platformMismatch: () =>
    problemBody(
      409,
      "platform_mismatch",
      "This connection is for another platform.",
      "This connection is for another platform, but the request came from a Medusa client.",
      { import_id: null },
    ),
  storeMismatch: () =>
    problemBody(
      409,
      "store_mismatch",
      "This connection is bound to another store.",
      "This connection is bound to a different store. If the store has moved, it can be unbound in Royalties HQ under Settings → Integrations → API.",
      { import_id: null },
    ),
  validationFailed: () =>
    problemBody(
      422,
      "validation_failed",
      "The snapshot is not valid.",
      "Fix the fields listed in `errors` and push the period again.",
      {
        errors: {
          "rows.0": ["The ISBN 9781234567890 has an invalid checksum."],
          "rows.1.currency": ["The currency must be a 3-letter ISO code."],
        },
      },
    ),
  duplicatePeriod: () =>
    problemBody(
      422,
      "duplicate_period",
      "This month is already in Royalties HQ.",
      "Sales for 2026-08 on Acme Shop are already imported.",
      {
        errors: { period: ["Already imported by import 290."] },
        import_ids: [290],
      },
    ),
  periodNotEnded: () =>
    problemBody(
      422,
      "period_not_ended",
      "This period has not ended yet.",
      "2026-09 can be pushed from 2026-10-01T00:00:00Z.",
    ),
  rateLimited: () =>
    problemBody(
      429,
      "rate_limited",
      "Too many requests.",
      "Wait for the number of seconds in the Retry-After header before trying again.",
    ),
  serverError: () =>
    problemBody(
      500,
      "server_error",
      "Something went wrong on our side.",
      "The request could not be completed. It is safe to retry later; if it keeps failing, contact the publisher.",
    ),
  unavailable: () =>
    problemBody(
      503,
      "service_unavailable",
      "The service is temporarily unavailable.",
      "Wait for the Retry-After interval, or a few minutes, and try again.",
    ),
  snapshotNotFound: () =>
    problemBody(
      404,
      "snapshot_not_found",
      "No snapshot has been pushed for this period.",
      "Nothing has been pushed for 2026-08 on this connection.",
    ),
  payloadTooLarge: () =>
    problemBody(
      413,
      "payload_too_large",
      "The request body is too large.",
      "Request bodies are limited to 5242880 bytes.",
    ),
} as const;

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Skip the wire checks: for deliberately non-RHQ answers. */
  raw?: boolean;
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The body as RHQ decodes it: inflated when it was sent gzipped. */
  body: string | null;
  /** The bytes as they crossed the wire. */
  bodyBytes: Uint8Array | null;
  compressed: boolean;
}

function operationOf(method: string, url: string) {
  const path = new URL(url).pathname;
  if (path.endsWith("/connection")) return "connection" as const;
  if (path.endsWith("/validate")) return "validate" as const;
  return method === "PUT" ? ("put" as const) : ("get" as const);
}

// Jest's expect takes no message (Vitest's does), so a contract failure
// throws with its label instead. Thrown inside fetch, the client reports it
// as network_error, which every test that expects an answer then fails on.
function assertNoWireErrors(label: string, errors: string[]): void {
  if (errors.length > 0) throw new Error(`${label}: ${errors.join("; ")}`);
}

/**
 * An injected fetch that answers from a queue (or a function) and records
 * what was sent, holding each write body and answer to the wire checks.
 */
export function fakeRhq(replies: Reply[] | ((request: SentRequest) => Reply)): {
  fetch: RhqFetch;
  sent: SentRequest[];
} {
  const sent: SentRequest[] = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  const fetch: RhqFetch = async (url, init) => {
    const bodyBytes =
      init.body === undefined
        ? null
        : typeof init.body === "string"
          ? new TextEncoder().encode(init.body)
          : init.body;
    const compressed = init.headers["Content-Encoding"] === "gzip";
    const decoded = bodyBytes && compressed ? gunzipSync(bodyBytes) : bodyBytes;
    const request: SentRequest = {
      method: init.method,
      url: String(url),
      headers: init.headers,
      body: decoded ? new TextDecoder().decode(decoded) : null,
      bodyBytes,
      compressed,
    };
    sent.push(request);
    const operation = operationOf(request.method, request.url);
    if (request.body !== null) {
      assertNoWireErrors(
        "request body",
        payloadErrors(JSON.parse(request.body)),
      );
    }
    const reply = queue
      ? queue.shift()
      : (replies as (r: SentRequest) => Reply)(request);
    if (!reply) throw new Error(`unexpected request ${init.method} ${url}`);
    if (!reply.raw) {
      assertNoWireErrors(
        `fake ${operation} ${reply.status}`,
        answerErrors(operation, reply.status, reply.body),
      );
    }
    const isProblem = !reply.raw && reply.status >= 400;
    const text =
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, {
      status: reply.status,
      headers: {
        "Content-Type": isProblem
          ? "application/problem+json"
          : "application/json",
        "Strict-Transport-Security": "max-age=31536000",
        ...reply.headers,
      },
    });
  };
  return { fetch, sent };
}

/** A payload the core would build, as canonical bytes. */
export function payloadFor(
  period: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    period,
    store_timezone: "Europe/London",
    generated_at: "2026-09-15T02:00:00Z",
    client: { platform: "medusa", version: "0.1.0" },
    settings: {
      commission_percent: null,
      card_fee_mode: "none",
      include_shipping: false,
      bundle_split: "platform_allocation",
      frequency_months: 1,
      push_day: 15,
      refund_cutoff_at: "2026-09-15T00:00:00+01:00",
    },
    rows: [
      {
        identifiers: {
          rhq_product_id: null,
          isbn: "9781234567897",
          sku: "POPPY-PB",
          asin: null,
          store_product_id: "prod_01JBX4Y7Q2P5ZK0V8N3RMEWT6C",
        },
        title: "Poppy's Promise",
        sale_country: "GB",
        currency: "GBP",
        units_sold: 14,
        royalty_on_sales: "187.43",
        units_refunded: 1,
        royalty_on_refunds: "-13.39",
        list_price: "14.99",
        discount_percent: null,
        breakdown: null,
      },
    ],
    summary: {
      orders_included: 12,
      orders_excluded: 0,
      unticked_product_lines: 0,
    },
    ...overrides,
  };
}

export function bytesFor(period: string, overrides = {}): Uint8Array {
  return new TextEncoder().encode(canonicalJson(payloadFor(period, overrides)));
}
