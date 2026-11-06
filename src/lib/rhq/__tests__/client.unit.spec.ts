import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { canonicalJson } from "../../../core/payload";
import {
  createHandshakeCache,
  createRhqClient,
  HANDSHAKE_TTL_MS,
  isLiveAcceptance,
  recordedCutoff,
  type RhqLogEntry,
} from "../client";
import { CLIENT_NAME, CLIENT_VERSION, USER_AGENT } from "../clientInfo";
import {
  createSafeFetch,
  UnexpectedRedirectError,
  UnsafeDestinationError,
} from "../../net/safeFetch";
import {
  BASE,
  bytesFor,
  connectionBody,
  fakeRhq,
  LIVE_TOKEN,
  PROBLEMS,
  snapshotData,
  TEST_TOKEN,
  payloadFor,
  type Reply,
} from "./support/fakeRhq";

// The client against a fake RHQ, plus one run over a real socket through safeFetch to prove the exact bytes and headers on the wire.

function clock(start = Date.parse("2026-09-15T02:00:00Z")) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function setup(
  replies: Reply[],
  options: { token?: string; baseUrl?: string } = {},
) {
  const fake = fakeRhq(replies);
  const time = clock();
  const logs: RhqLogEntry[] = [];
  const cache = createHandshakeCache();
  const make = (token = options.token ?? LIVE_TOKEN) =>
    createRhqClient({
      baseUrl: options.baseUrl ?? BASE,
      token,
      fetch: fake.fetch,
      now: time.now,
      logger: (entry) => logs.push(entry),
      handshakeCache: cache,
    });
  return { ...fake, time, logs, cache, client: make(), make };
}

describe("handshake", () => {
  it("GETs /connection with the bearer token and returns the typed connection", async () => {
    const { client, sent } = setup([{ status: 200, body: connectionBody() }]);
    const result = await client.handshake();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "GET",
      url: `${BASE}/connection`,
      body: null,
    });
    expect(sent[0]!.headers).toMatchObject({
      Authorization: `Bearer ${LIVE_TOKEN}`,
      Accept: "application/json",
    });
    expect(sent[0]!.headers["Content-Type"]).toBeUndefined();
    if (!result.ok) throw new Error(result.problem.code);
    expect(result.status).toBe(200);
    expect(result.mode).toBe("live");
    expect(result.connection).toMatchObject({
      name: "Acme Press Medusa",
      currency: "GBP",
      royalty_period_months: 6,
      token: { mode: "live", expires_at: "2027-09-01T00:00:00Z" },
    });
    expect(result.connection.periods).toHaveLength(2);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const { client, sent } = setup([{ status: 200, body: connectionBody() }], {
      baseUrl: `${BASE}/`,
    });
    await client.handshake();
    expect(sent[0]!.url).toBe(`${BASE}/connection`);
  });

  it("reports a test-mode token", async () => {
    const body = connectionBody({
      token: { mode: "test", expires_at: null },
    });
    const { client } = setup([{ status: 200, body }], { token: TEST_TOKEN });
    const result = await client.handshake();
    expect(result.ok && result.mode).toBe("test");
    expect(client.mode()).toBe("test");
  });

  it("caches a success for a short TTL, per base URL and token", async () => {
    const { client, make, sent, time } = setup([
      { status: 200, body: connectionBody() },
      { status: 200, body: connectionBody() },
      { status: 200, body: connectionBody() },
    ]);
    await client.handshake();
    time.advance(HANDSHAKE_TTL_MS - 1);
    await client.handshake();
    // Another client instance for the same (URL, token) shares the entry.
    await make().handshake();
    expect(sent).toHaveLength(1);
    // A different token is a different connection.
    await make(`rhq_live_${"z".repeat(40)}QQQQ0000`).handshake();
    expect(sent).toHaveLength(2);
    time.advance(1);
    await client.handshake();
    expect(sent).toHaveLength(3);
  });

  it("the cache key holds a hash of the token, not the token", async () => {
    const { client, cache } = setup([{ status: 200, body: connectionBody() }]);
    await client.handshake();
    const keys = cache.keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(LIVE_TOKEN);
    expect(keys[0]).toContain(
      createHash("sha256").update(LIVE_TOKEN).digest("hex"),
    );
  });

  it("can be invalidated explicitly, and bypassed with fresh", async () => {
    const { client, sent } = setup([
      { status: 200, body: connectionBody() },
      { status: 200, body: connectionBody() },
      { status: 200, body: connectionBody() },
    ]);
    await client.handshake();
    client.invalidateHandshake();
    await client.handshake();
    await client.handshake({ fresh: true });
    expect(sent).toHaveLength(3);
  });

  it("does not cache a failure", async () => {
    const { client, sent } = setup([
      { status: 401, body: PROBLEMS.unauthenticated() },
      { status: 200, body: connectionBody() },
    ]);
    const first = await client.handshake();
    expect(!first.ok && first.problem.code).toBe("unauthenticated");
    expect((await client.handshake()).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("an answer of the wrong shape is an unexpected_response", async () => {
    const { client } = setup([
      { status: 200, body: { data: { name: "half a connection" } }, raw: true },
    ]);
    const result = await client.handshake();
    expect(!result.ok && result.problem).toMatchObject({
      code: "unexpected_response",
      status: 200,
    });
  });
});

describe("recordedCutoff", () => {
  it("returns the cut-off RHQ recorded for a period, or null", async () => {
    const { client } = setup([{ status: 200, body: connectionBody() }]);
    const result = await client.handshake();
    if (!result.ok) throw new Error("handshake");
    expect(recordedCutoff(result.connection, "2026-08")).toBe(
      "2026-09-14T23:00:00Z",
    );
    expect(recordedCutoff(result.connection, "2026-06")).toBeNull();
  });
});

describe("putSnapshot", () => {
  it("PUTs the exact bytes it was given, with JSON headers", async () => {
    const bytes = bytesFor("2026-08");
    const { client, sent } = setup([
      {
        status: 202,
        body: { data: snapshotData({ result: "created" }) },
        headers: { Location: `${BASE}/sales-snapshots/2026-08` },
      },
    ]);
    const result = await client.putSnapshot("2026-08", bytes);
    expect(sent[0]).toMatchObject({
      method: "PUT",
      url: `${BASE}/sales-snapshots/2026-08`,
    });
    expect(Buffer.from(sent[0]!.bodyBytes!).equals(Buffer.from(bytes))).toBe(
      true,
    );
    expect(sent[0]!.headers).toMatchObject({
      Authorization: `Bearer ${LIVE_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    expect(result).toMatchObject({
      ok: true,
      status: 202,
      result: "created",
      mode: "live",
      dryRun: false,
      snapshot: { period: "2026-08", status: "staged", import_id: 342 },
    });
    expect(isLiveAcceptance(result)).toBe(true);
  });

  it("accepts the payload as a string too", async () => {
    const text = new TextDecoder().decode(bytesFor("2026-08"));
    const { client, sent } = setup([
      { status: 202, body: { data: snapshotData({ result: "replaced" }) } },
    ]);
    const result = await client.putSnapshot("2026-08", text);
    expect(sent[0]!.body).toBe(text);
    expect(result.ok && result.result).toBe("replaced");
  });

  it("maps a byte-identical re-push to 200 unchanged", async () => {
    const { client } = setup([
      { status: 200, body: { data: snapshotData({ result: "unchanged" }) } },
    ]);
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      result: "unchanged",
    });
    expect(isLiveAcceptance(result)).toBe(true);
  });

  it("refuses, before sending, a body whose period is not the path's", async () => {
    const { client, sent } = setup([]);
    await expect(
      client.putSnapshot("2026-07", bytesFor("2026-08")),
    ).rejects.toThrow(/period/);
    await expect(
      client.putSnapshot("2026-13", bytesFor("2026-13")),
    ).rejects.toThrow(/period/);
    await expect(client.putSnapshot("2026-08", "{not json")).rejects.toThrow(
      /JSON/,
    );
    expect(sent).toEqual([]);
  });

  it("marks a test-mode answer so the caller never records the period as pushed", async () => {
    const { client } = setup(
      [
        {
          status: 202,
          body: {
            data: snapshotData({ result: "created", import_id: null }),
            mode: "test",
          },
        },
      ],
      { token: TEST_TOKEN },
    );
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    expect(result).toMatchObject({ ok: true, mode: "test", dryRun: false });
    expect(isLiveAcceptance(result)).toBe(false);
    expect(client.mode()).toBe("test");
  });

  it("treats a test token as test mode even if an answer lacks the marker", async () => {
    // Belt and braces: marking a month pushed after a dry run would stop
    // it ever being pushed for real.
    const { client } = setup(
      [{ status: 202, body: { data: snapshotData({ result: "created" }) } }],
      { token: TEST_TOKEN },
    );
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    expect(result.ok && result.mode).toBe("test");
    expect(isLiveAcceptance(result)).toBe(false);
  });

  it("invalidates the cached handshake, whose periods the push changed", async () => {
    const { client, sent } = setup([
      { status: 200, body: connectionBody() },
      { status: 202, body: { data: snapshotData({ result: "replaced" }) } },
      { status: 200, body: connectionBody() },
    ]);
    await client.handshake();
    await client.putSnapshot("2026-08", bytesFor("2026-08"));
    await client.handshake();
    expect(sent.map((s) => s.method)).toEqual(["GET", "PUT", "GET"]);
  });
});

describe("validateSnapshot", () => {
  it("POSTs to /validate and reports a dry run", async () => {
    const { client, sent } = setup([
      {
        status: 202,
        body: {
          data: snapshotData({ result: "replaced", import_id: null }),
          dry_run: true,
        },
      },
    ]);
    const result = await client.validateSnapshot(
      "2026-08",
      bytesFor("2026-08"),
    );
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: `${BASE}/sales-snapshots/2026-08/validate`,
    });
    expect(result).toMatchObject({ ok: true, dryRun: true, mode: "live" });
    expect(isLiveAcceptance(result)).toBe(false);
  });

  it("carries dry_run and mode on a problem too", async () => {
    const { client } = setup(
      [
        {
          status: 422,
          body: { ...PROBLEMS.validationFailed(), dry_run: true, mode: "test" },
        },
      ],
      { token: TEST_TOKEN },
    );
    const result = await client.validateSnapshot(
      "2026-08",
      bytesFor("2026-08"),
    );
    expect(!result.ok && result.problem).toMatchObject({
      code: "validation_failed",
      dryRun: true,
      mode: "test",
    });
  });
});

describe("getSnapshot", () => {
  it("GETs the month's status", async () => {
    const { client, sent } = setup([
      {
        status: 200,
        body: {
          data: snapshotData({
            status: "rejected",
            rejection_code: "validation_failed",
            counts: { rows: 2, errors: 1, warnings: 0 },
            errors: { "rows.1": ["Unknown product."] },
          }),
        },
      },
    ]);
    const result = await client.getSnapshot("2026-08");
    expect(sent[0]).toMatchObject({
      method: "GET",
      url: `${BASE}/sales-snapshots/2026-08`,
      body: null,
    });
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      snapshot: { status: "rejected", rejection_code: "validation_failed" },
    });
  });

  it("reads a failed commit's error", async () => {
    // The import failed to commit: the month stays staged with the same
    // import id.
    const { client } = setup([
      {
        status: 200,
        body: {
          data: snapshotData({
            counts: { rows: 2, errors: 1, warnings: 0 },
            errors: {
              rows: [
                "Unexpected error while importing: the import could not be saved",
              ],
            },
          }),
        },
      },
    ]);
    const result = await client.getSnapshot("2026-08");
    expect(result.ok && result.snapshot.errorEntries).toEqual([
      {
        key: "rows",
        message:
          "Unexpected error while importing: the import could not be saved",
        reason: null,
      },
    ]);
  });

  it("reads a reason-coded error entry", async () => {
    // An object with a stable reason where the message string was. Reading
    // it as unexpected_response would hide exactly the failure it reports.
    const entry = {
      row: null,
      reason: "import_failed",
      message:
        "The import could not be completed in Royalties HQ. Retry or delete it there.",
    };
    const { client } = setup([
      {
        status: 200,
        raw: true,
        body: {
          data: snapshotData({
            counts: { rows: 2, errors: 1, warnings: 0 },
            errors: { rows: [entry] },
          }),
        },
      },
      {
        status: 200,
        raw: true,
        body: {
          data: snapshotData({
            counts: { rows: 2, errors: 1, warnings: 0 },
            errors: [entry],
          }),
        },
      },
    ]);
    for (const key of ["rows", "rows"]) {
      const result = await client.getSnapshot("2026-08");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.errorEntries).toEqual([
        { key, message: entry.message, reason: "import_failed" },
      ]);
      // Existing readers keep a plain messages-by-key object.
      expect(result.snapshot.errors).toEqual({ rows: [entry.message] });
    }
  });

  it("maps 404 snapshot_not_found", async () => {
    const { client } = setup([
      { status: 404, body: PROBLEMS.snapshotNotFound() },
    ]);
    const result = await client.getSnapshot("2026-08");
    expect(!result.ok && result.problem.code).toBe("snapshot_not_found");
  });
});

describe("problems", () => {
  const cases: Array<[string, Reply, Record<string, unknown>]> = [
    [
      "period_committed",
      { status: 409, body: PROBLEMS.periodCommitted() },
      { status: 409, importId: 342, retryAfterSeconds: null },
    ],
    [
      "snapshot_in_progress",
      {
        status: 409,
        body: PROBLEMS.inProgress(),
        headers: { "Retry-After": "60" },
      },
      { status: 409, retryAfterSeconds: 60 },
    ],
    [
      "validation_failed",
      { status: 422, body: PROBLEMS.validationFailed() },
      {
        errors: {
          "rows.0": ["The ISBN 9781234567890 has an invalid checksum."],
          "rows.1.currency": ["The currency must be a 3-letter ISO code."],
        },
      },
    ],
    [
      "duplicate_period",
      { status: 422, body: PROBLEMS.duplicatePeriod() },
      { importIds: [290] },
    ],
    [
      "period_not_ended",
      { status: 422, body: PROBLEMS.periodNotEnded() },
      { detail: "2026-09 can be pushed from 2026-10-01T00:00:00Z." },
    ],
    [
      "rate_limited",
      {
        status: 429,
        body: PROBLEMS.rateLimited(),
        headers: {
          "Retry-After": "17",
          "X-RateLimit-Limit": "30",
          "X-RateLimit-Remaining": "0",
        },
      },
      { status: 429, retryAfterSeconds: 17 },
    ],
    [
      "service_unavailable",
      {
        status: 503,
        body: PROBLEMS.unavailable(),
        headers: { "Retry-After": "120" },
      },
      { retryAfterSeconds: 120 },
    ],
    ["unauthenticated", { status: 401, body: PROBLEMS.unauthenticated() }, {}],
    ["forbidden", { status: 403, body: PROBLEMS.forbidden() }, {}],
    ["https_required", { status: 403, body: PROBLEMS.httpsRequired() }, {}],
    ["server_error", { status: 500, body: PROBLEMS.serverError() }, {}],
    [
      "payload_too_large",
      { status: 413, body: PROBLEMS.payloadTooLarge() },
      {},
    ],
  ];

  it.each(cases)("parses %s from problem+json", async (code, reply, more) => {
    const { client } = setup([reply]);
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    if (result.ok) throw new Error("expected a problem");
    expect(result.problem).toMatchObject({
      code,
      title: (reply.body as { title: string }).title,
      status: reply.status,
      ...more,
    });
  });

  it("reads an HTTP-date Retry-After as seconds from now", async () => {
    const { client } = setup([
      {
        status: 503,
        body: PROBLEMS.unavailable(),
        headers: { "Retry-After": "Tue, 15 Sep 2026 02:05:00 GMT" },
      },
    ]);
    const result = await client.handshake();
    expect(!result.ok && result.problem.retryAfterSeconds).toBe(300);
  });

  it("branches on code, not status: an unknown code keeps its own code", async () => {
    const { client } = setup([
      {
        status: 422,
        body: {
          type: "urn:royaltieshq:problem:shiny_new_check",
          title: "Something new.",
          status: 422,
          code: "shiny_new_check",
          detail: null,
        },
        raw: true,
        headers: { "Content-Type": "application/problem+json" },
      },
    ]);
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    expect(!result.ok && result.problem.code).toBe("shiny_new_check");
  });

  it("a non-problem error body is an unexpected_response with its status", async () => {
    const { client } = setup([
      {
        status: 502,
        body: "<html><body>Bad gateway</body></html>",
        raw: true,
        headers: { "Content-Type": "text/html" },
      },
    ]);
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    expect(!result.ok && result.problem).toMatchObject({
      code: "unexpected_response",
      status: 502,
    });
    // The body is not echoed: it could be anything a proxy serves.
    expect(JSON.stringify(result)).not.toContain("Bad gateway");
  });

  it("a JSON error that is not problem+json is an unexpected_response", async () => {
    const { client } = setup([
      {
        status: 500,
        body: { message: "Server Error" },
        raw: true,
        headers: { "Content-Type": "application/json" },
      },
    ]);
    const result = await client.getSnapshot("2026-08");
    expect(!result.ok && result.problem.code).toBe("unexpected_response");
  });
});

describe("local failures", () => {
  function clientWith(fetch: Parameters<typeof createRhqClient>[0]["fetch"]) {
    return createRhqClient({
      baseUrl: BASE,
      token: LIVE_TOKEN,
      fetch,
      handshakeCache: createHandshakeCache(),
      logger: () => {},
      timeoutMs: 50,
    });
  }

  it("a network error is network_error, with no status", async () => {
    const client = clientWith(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await client.handshake();
    expect(!result.ok && result.problem).toMatchObject({
      code: "network_error",
      status: null,
    });
  });

  it("gives up after the timeout, as timeout", async () => {
    const client = clientWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(init.signal.reason),
          );
        }),
    );
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    expect(!result.ok && result.problem.code).toBe("timeout");
  });

  it("uses a 60 s timeout by default", async () => {
    let seen: AbortSignal | undefined;
    const client = createRhqClient({
      baseUrl: BASE,
      token: LIVE_TOKEN,
      handshakeCache: createHandshakeCache(),
      logger: () => {},
      fetch: async (_url, init) => {
        seen = init.signal;
        return new Response(JSON.stringify(connectionBody()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    await client.handshake();
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(client.timeoutMs).toBe(60_000);
  });

  it("maps safeFetch's refusals to their own codes", async () => {
    const unsafe = clientWith(async () => {
      throw new UnsafeDestinationError("10.0.0.1 is a private address.");
    });
    const redirect = clientWith(async () => {
      throw new UnexpectedRedirectError(302);
    });
    expect(await unsafe.handshake()).toMatchObject({
      ok: false,
      problem: { code: "unsafe_destination", status: null },
    });
    expect(await redirect.handshake()).toMatchObject({
      ok: false,
      problem: { code: "unexpected_redirect", status: 302 },
    });
  });

  // The answer used to be read whole with
  // response.text(). A wrong or hostile base URL could stream the worker
  // out of memory; no RHQ answer comes near 1 MiB.
  it("abandons a body past 1 MiB as response_too_large, without reading it all", async () => {
    let pulled = 0;
    let cancelled = false;
    const client = clientWith(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const result = await client.handshake();
    expect(!result.ok && result.problem).toMatchObject({
      code: "response_too_large",
      status: 200,
    });
    expect(pulled).toBeLessThan(40);
    expect(cancelled).toBe(true);
  });

  it("refuses a declared Content-Length over 1 MiB before reading", async () => {
    let pulled = 0;
    const client = clientWith(async () => {
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
        { status: 200 },
      );
      // A Response's own headers are immutable-by-guard only for fetch
      // results; a constructed one lets the test declare a length.
      response.headers.set("Content-Length", String(1024 * 1024 + 1));
      return response;
    });
    const result = await client.handshake();
    expect(!result.ok && result.problem.code).toBe("response_too_large");
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("goes through safeFetch by default, so a private host is refused", async () => {
    // The unit project runs with NODE_ENV=test and no
    // ROYALTIES_HQ_ALLOW_PRIVATE_HOSTS, so the process policy is strict.
    const client = createRhqClient({
      baseUrl: "https://127.0.0.1:9/api/v1",
      token: LIVE_TOKEN,
      handshakeCache: createHandshakeCache(),
      logger: () => {},
    });
    const result = await client.handshake();
    expect(!result.ok && result.problem.code).toBe("unsafe_destination");
  });
});

describe("logging", () => {
  it("logs method, path, status, code, duration and payload hash, never the token or body", async () => {
    const bytes = bytesFor("2026-08");
    const { client, logs } = setup([
      { status: 200, body: connectionBody() },
      { status: 422, body: PROBLEMS.validationFailed() },
    ]);
    await client.handshake();
    await client.putSnapshot("2026-08", bytes);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/connection",
      status: 200,
      code: null,
      payloadHash: null,
    });
    expect(logs[1]).toMatchObject({
      method: "PUT",
      path: "/api/v1/sales-snapshots/2026-08",
      status: 422,
      code: "validation_failed",
      payloadHash: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(typeof logs[1]!.durationMs).toBe("number");
    const text = JSON.stringify(logs);
    expect(text).not.toContain(LIVE_TOKEN);
    expect(text).not.toContain("rhq_live_");
    expect(text).not.toContain("POPPY-PB");
    expect(text).not.toContain("187.43");
  });

  it("logs local failures without the token", async () => {
    const logs: RhqLogEntry[] = [];
    const client = createRhqClient({
      baseUrl: BASE,
      token: LIVE_TOKEN,
      handshakeCache: createHandshakeCache(),
      logger: (e) => logs.push(e),
      fetch: async () => {
        throw new TypeError(`fetch failed for ${LIVE_TOKEN}`);
      },
    });
    await client.handshake();
    expect(logs[0]).toMatchObject({ status: null, code: "network_error" });
    expect(JSON.stringify(logs)).not.toContain(LIVE_TOKEN);
  });
});

describe("over a real socket through safeFetch", () => {
  let server: Server;
  let port: number;
  const received: Array<{ req: IncomingMessage; body: Buffer }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ req, body: Buffer.concat(chunks) });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: snapshotData({ result: "created" }) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it("sends exactly the canonical bytes, with the JSON and bearer headers", async () => {
    const bytes = bytesFor("2026-08");
    const client = createRhqClient({
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      token: LIVE_TOKEN,
      fetch: createSafeFetch({
        policy: { allowHttp: true, allowPrivate: true },
      }),
      handshakeCache: createHandshakeCache(),
      logger: () => {},
    });
    const result = await client.putSnapshot("2026-08", bytes);
    expect(result.ok).toBe(true);
    const { req, body } = received[0]!;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("/api/v1/sales-snapshots/2026-08");
    expect(body.equals(Buffer.from(bytes))).toBe(true);
    expect(req.headers.authorization).toBe(`Bearer ${LIVE_TOKEN}`);
    expect(req.headers.accept).toBe("application/json");
    expect(req.headers["content-type"]).toBe("application/json");
  });
});

describe("live API additions", () => {
  it("reads what the handshake says about the install", async () => {
    const { client } = setup([
      {
        status: 200,
        body: connectionBody({
          auto_import: false,
          store: { bound: true },
        }),
      },
    ]);
    const result = await client.handshake();
    if (!result.ok) throw new Error(result.problem.code);
    expect(result.connection.auto_import).toBe(false);
    expect(result.connection.store).toEqual({ bound: true });
    expect(result.connection.api).toEqual({
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
    });
  });

  it("reads an install that predates them as describing nothing", async () => {
    // One service talks to many installs, each upgraded on its own.
    const body = connectionBody();
    const data = body.data as Record<string, unknown>;
    delete data.auto_import;
    delete data.store;
    delete data.api;
    const { client } = setup([{ status: 200, body, raw: true }]);
    const result = await client.handshake();
    if (!result.ok) throw new Error(result.problem.code);
    expect(result.connection.auto_import).toBeNull();
    expect(result.connection.store).toBeNull();
    expect(result.connection.api).toBeNull();
  });

  it("ignores features and limits it does not know, and limits that are not positive integers", async () => {
    const body = connectionBody({
      api: {
        features: ["gzip", "brotli", 7],
        limits: { max_rows: 5000, max_widgets: 3, max_json_values: -1 },
      },
    });
    const { client } = setup([{ status: 200, body, raw: true }]);
    const result = await client.handshake();
    if (!result.ok) throw new Error(result.problem.code);
    expect(result.connection.api).toEqual({
      features: ["gzip", "brotli"],
      limits: { max_rows: 5000 },
    });
  });

  it("refuses the removed superseded status as an unexpected answer", async () => {
    const { client } = setup([
      {
        status: 200,
        raw: true,
        body: { data: snapshotData({ status: "superseded" }) },
      },
    ]);
    const result = await client.getSnapshot("2026-08");
    expect(!result.ok && result.problem.code).toBe("unexpected_response");
  });

  it("reads the receipt hash, hold-back reasons and the import link", async () => {
    const hash = "0123456789abcdef".repeat(4);
    const { client } = setup([
      {
        status: 202,
        body: {
          data: snapshotData({
            result: "created",
            payload_sha256: hash,
            hold_back_reasons: ["no_baseline", "before_backfill_start"],
          }),
        },
      },
    ]);
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    if (!result.ok) throw new Error(result.problem.code);
    expect(result.snapshot.payload_sha256).toBe(hash);
    expect(result.snapshot.hold_back_reasons).toEqual([
      "no_baseline",
      "before_backfill_start",
    ]);
    expect(result.snapshot.links.import).toBe(
      "https://acme.royaltieshq.com/imports/342",
    );
    expect(result.snapshot.errors_truncated).toBe(false);
  });

  it("drops an import link that is not on the API's own origin", async () => {
    // RHQ builds it from APP_URL, the same host as the API base URL; a link
    // anywhere else is not one anyone should be sent to.
    const { client } = setup([
      {
        status: 200,
        body: {
          data: snapshotData({
            links: {
              self: `${BASE}/sales-snapshots/2026-08`,
              import: "https://evil.example/imports/342",
            },
          }),
        },
      },
    ]);
    const result = await client.getSnapshot("2026-08");
    expect(result.ok && result.snapshot.links.import).toBeNull();
  });

  it("reads a failed commit under the import key as import_failed", async () => {
    const message =
      "The import could not be completed in Royalties HQ. Retry, or delete the import in Royalties HQ.";
    const { client } = setup([
      {
        status: 200,
        body: {
          data: snapshotData({
            counts: { rows: 2, errors: 1, warnings: 0 },
            errors: { import: [message] },
          }),
        },
      },
    ]);
    const result = await client.getSnapshot("2026-08");
    expect(result.ok && result.snapshot.errorEntries).toEqual([
      { key: "import", message, reason: "import_failed" },
    ]);
  });

  it("carries a truncated error list's flag and total on a problem", async () => {
    const { client } = setup([
      {
        status: 422,
        body: {
          ...PROBLEMS.validationFailed(),
          errors_truncated: true,
          errors_total: 5000,
        },
      },
    ]);
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    expect(!result.ok && result.problem).toMatchObject({
      code: "validation_failed",
      errorsTruncated: true,
      errorsTotal: 5000,
    });
  });

  it("keeps the connection codes platform_mismatch and store_mismatch", async () => {
    const { client } = setup([
      { status: 409, body: PROBLEMS.platformMismatch() },
      { status: 409, body: PROBLEMS.storeMismatch() },
    ]);
    for (const code of ["platform_mismatch", "store_mismatch"]) {
      const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
      expect(!result.ok && result.problem.code).toBe(code);
    }
  });

  it("sends gzip when asked, hashing and logging the uncompressed body", async () => {
    const { client, sent, logs } = setup([
      {
        status: 202,
        body: { data: snapshotData({ result: "created" }) },
      },
    ]);
    const bytes = bytesFor("2026-08");
    await client.putSnapshot("2026-08", bytes, { gzip: true });
    expect(sent[0]!.headers["Content-Encoding"]).toBe("gzip");
    expect(sent[0]!.compressed).toBe(true);
    expect(sent[0]!.body).toBe(new TextDecoder().decode(bytes));
    expect(logs[0]!.payloadHash).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it("sends no Content-Encoding by default", async () => {
    const { client, sent } = setup([
      { status: 202, body: { data: snapshotData({ result: "created" }) } },
    ]);
    await client.putSnapshot("2026-08", bytesFor("2026-08"));
    expect(sent[0]!.headers["Content-Encoding"]).toBeUndefined();
    expect(sent[0]!.compressed).toBe(false);
  });
});

describe("answers that cannot be read in full", () => {
  it("keeps the HTTP status when the body breaks off after the headers", async () => {
    // A 2xx whose body never arrived may still have stored the month, so
    // the push step must see the status to read the month back.
    const client = createRhqClient({
      baseUrl: BASE,
      token: LIVE_TOKEN,
      handshakeCache: createHandshakeCache(),
      logger: () => {},
      fetch: async () => ({
        status: 202,
        headers: new Headers({ "Content-Type": "application/json" }),
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        text: async () => "",
      }),
    });
    const result = await client.putSnapshot("2026-08", bytesFor("2026-08"));
    expect(!result.ok && result.problem).toMatchObject({
      code: "network_error",
      status: 202,
    });
  });
});

describe("payload_sha256 presence", () => {
  it("reads an absent hash as undefined and a null one as null", async () => {
    const absent = snapshotData();
    delete absent.payload_sha256;
    const { client } = setup([
      { status: 200, raw: true, body: { data: absent } },
      { status: 200, body: { data: snapshotData({ payload_sha256: null }) } },
    ]);
    const old = await client.getSnapshot("2026-08");
    expect(old.ok && old.snapshot.payload_sha256).toBeUndefined();
    const deleted = await client.getSnapshot("2026-08");
    expect(deleted.ok && deleted.snapshot.payload_sha256).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Medusa: the client names itself in a User-Agent, and makes the bytes to
// send, store.id included.

describe("Medusa: the client names itself", () => {
  it("is royalties-hq-medusa at the package's version", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "../../../../package.json"), "utf8"),
    ) as { version: string };
    expect(CLIENT_NAME).toBe("royalties-hq-medusa");
    expect(CLIENT_VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(`royalties-hq-medusa/${pkg.version}`);
  });

  it("sends it as the User-Agent on every request", async () => {
    const { client, sent } = setup([
      { status: 200, body: connectionBody() },
      { status: 202, body: { data: snapshotData({ result: "created" }) } },
      { status: 200, body: { data: snapshotData() } },
    ]);
    await client.handshake();
    await client.putSnapshot("2026-08", bytesFor("2026-08"));
    await client.getSnapshot("2026-08");
    expect(sent.map((r) => r.headers["User-Agent"])).toEqual([
      USER_AGENT,
      USER_AGENT,
      USER_AGENT,
    ]);
    // No store or shop name in it: the header is not the place to say
    // which store is pushing.
    expect(USER_AGENT).toMatch(/^royalties-hq-medusa\/[0-9A-Za-z.+-]+$/);
  });
});

describe("Medusa: store.id, attached when sending", () => {
  const STORE_ID = "medusa:store_01JBX4Y7Q2P5ZK0V8N3RMEWT6C";

  // The fixture's install, with its features replaced (null: an install
  // that predates api altogether).
  function connectionWith(features: string[] | null) {
    const body = connectionBody();
    const data = body.data as Record<string, unknown>;
    if (features === null) delete data.api;
    else data.api = { ...(data.api as Record<string, unknown>), features };
    return body;
  }

  async function handshakeFor(
    features: string[] | null,
    storeId: string | undefined,
  ) {
    const fake = fakeRhq([
      { status: 200, body: connectionWith(features), raw: features === null },
    ]);
    const client = createRhqClient({
      baseUrl: BASE,
      token: LIVE_TOKEN,
      fetch: fake.fetch,
      logger: () => {},
      handshakeCache: createHandshakeCache(),
      storeId,
    });
    const result = await client.handshake();
    if (!result.ok) throw new Error(result.problem.code);
    return { client, connection: result.connection, sent: fake.sent };
  }

  it("adds store.id to the body when the install lists store_id", async () => {
    const { client, connection } = await handshakeFor(
      ["store_id", "gzip"],
      STORE_ID,
    );
    const payload = payloadFor("2026-08");
    const body = client.bodyFor(payload, connection);
    expect(body).toBe(canonicalJson({ ...payload, store: { id: STORE_ID } }));
    // The built payload is not changed: store.id is never stored in it.
    expect(payload).not.toHaveProperty("store");
  });

  it("sends no store to an install that does not list store_id", async () => {
    for (const features of [["gzip"], null]) {
      const { client, connection } = await handshakeFor(features, STORE_ID);
      const payload = payloadFor("2026-08");
      expect(client.bodyFor(payload, connection)).toBe(canonicalJson(payload));
    }
  });

  it("refuses to build a body for a store_id install without a store id", async () => {
    // RHQ would take an unbound push and leave the connection open to any
    // store, so nothing may be sent.
    const { client, connection, sent } = await handshakeFor(
      ["store_id"],
      undefined,
    );
    expect(() => client.bodyFor(payloadFor("2026-08"), connection)).toThrow(
      /store id/i,
    );
    expect(sent).toHaveLength(1); // only the handshake
  });

  it("puts the store-carrying body byte for byte", async () => {
    const { client, connection } = await handshakeFor(["store_id"], STORE_ID);
    const fake = fakeRhq([
      { status: 202, body: { data: snapshotData({ result: "created" }) } },
    ]);
    const sender = createRhqClient({
      baseUrl: BASE,
      token: LIVE_TOKEN,
      fetch: fake.fetch,
      logger: () => {},
      handshakeCache: createHandshakeCache(),
      storeId: STORE_ID,
    });
    const body = client.bodyFor(payloadFor("2026-08"), connection);
    const result = await sender.putSnapshot("2026-08", body);
    expect(result.ok).toBe(true);
    expect(fake.sent[0]!.body).toBe(body);
    expect(JSON.parse(fake.sent[0]!.body!).store).toEqual({ id: STORE_ID });
  });
});

describe("Medusa: over a real socket", () => {
  let server: Server;
  let port: number;
  const agents: Array<string | undefined> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      agents.push(req.headers["user-agent"]);
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(connectionBody()));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("sends the User-Agent on the wire", async () => {
    const client = createRhqClient({
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      token: LIVE_TOKEN,
      fetch: createSafeFetch({
        policy: { allowHttp: true, allowPrivate: true },
      }),
      handshakeCache: createHandshakeCache(),
      logger: () => {},
    });
    const result = await client.handshake();
    expect(result.ok).toBe(true);
    expect(agents).toEqual([USER_AGENT]);
  });
});
