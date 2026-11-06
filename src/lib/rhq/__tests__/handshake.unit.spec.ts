
import { createHandshakeCache } from "../client";
import { createRhqHandshake } from "../handshake";
import {
  BASE,
  connectionBody,
  fakeRhq,
  LIVE_TOKEN,
  PROBLEMS,
  TEST_TOKEN,
} from "./support/fakeRhq";

// The settings page's Test connection, backed by the real client: RHQ's
// answers mapped onto the page's success and problem shapes.

function handshakeWith(replies: Parameters<typeof fakeRhq>[0]) {
  const fake = fakeRhq(replies);
  const handshake = createRhqHandshake({
    fetch: fake.fetch,
    logger: () => {},
    handshakeCache: createHandshakeCache(),
  });
  return { handshake, sent: fake.sent };
}

describe("createRhqHandshake", () => {
  it("maps the connection to what the page shows", async () => {
    const { handshake, sent } = handshakeWith([
      { status: 200, body: connectionBody() },
    ]);
    const result = await handshake.testConnection({
      baseUrl: BASE,
      token: LIVE_TOKEN,
    });
    expect(result).toEqual({
      ok: true,
      connection: {
        // Recorded by the Test connection route, so the status page follows
        // a new token's connection without waiting for a push.
        id: 7,
        name: "Acme Press Medusa",
        currency: "GBP",
        marketplace: "Acme Shop",
        tokenMode: "live",
        tokenExpiresAt: "2027-09-01T00:00:00Z",
      },
    });
    expect(sent[0]!.headers.Authorization).toBe(`Bearer ${LIVE_TOKEN}`);
  });

  it("shows a test token as test mode, and a token that never expires", async () => {
    const { handshake } = handshakeWith([
      {
        status: 200,
        body: connectionBody({ token: { mode: "test", expires_at: null } }),
      },
    ]);
    const result = await handshake.testConnection({
      baseUrl: BASE,
      token: TEST_TOKEN,
    });
    expect(result).toMatchObject({
      ok: true,
      connection: { tokenMode: "test", tokenExpiresAt: null },
    });
  });

  it("always asks RHQ, never a cached answer, so a revoked token shows at once", async () => {
    const { handshake, sent } = handshakeWith([
      { status: 200, body: connectionBody() },
      { status: 401, body: PROBLEMS.unauthenticated() },
    ]);
    const connection = { baseUrl: BASE, token: LIVE_TOKEN };
    expect((await handshake.testConnection(connection)).ok).toBe(true);
    const second = await handshake.testConnection(connection);
    expect(sent).toHaveLength(2);
    expect(second).toEqual({
      ok: false,
      problem: {
        code: "unauthenticated",
        title: "Authentication required.",
        detail:
          "Send a valid, unexpired API token as a Bearer token in the Authorization header.",
        httpStatus: 401,
      },
    });
  });

  it("maps a local failure with a null status", async () => {
    const handshake = createRhqHandshake({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      logger: () => {},
      handshakeCache: createHandshakeCache(),
    });
    const result = await handshake.testConnection({
      baseUrl: BASE,
      token: LIVE_TOKEN,
    });
    expect(result).toMatchObject({
      ok: false,
      problem: { code: "network_error", httpStatus: null },
    });
  });
});
