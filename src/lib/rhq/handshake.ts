import { createRhqClient, type RhqClientOptions } from "./client";

// The settings page's Test connection, backed by the real client, in the
// smaller shapes the admin API returns.

/** Where to connect: a normalised base URL (…/api/v1) and the plain token. */
export interface RhqEndpoint {
  baseUrl: string;
  /** Never logged, never returned to the browser. */
  token: string;
}

/** What the handshake (GET /api/v1/connection) tells the admin. */
export interface RhqConnectionInfo {
  id: number;
  name: string;
  /** The publisher's reporting currency. */
  currency: string;
  marketplace: string;
  tokenMode: "live" | "test";
  /** ISO instant (UTC), or null when the token never expires. */
  tokenExpiresAt: string | null;
}

/**
 * RHQ's problem+json, or a local failure in the same shape with a null
 * status, as the admin page shows it.
 */
export interface HandshakeProblem {
  code: string;
  title: string;
  detail: string | null;
  httpStatus: number | null;
}

export type HandshakeResult =
  | { ok: true; connection: RhqConnectionInfo }
  | { ok: false; problem: HandshakeProblem };

export interface RhqHandshake {
  testConnection(endpoint: RhqEndpoint): Promise<HandshakeResult>;
}

export type HandshakeDeps = Omit<RhqClientOptions, "baseUrl" | "token">;

export function createRhqHandshake(deps: HandshakeDeps = {}): RhqHandshake {
  return {
    async testConnection({
      baseUrl,
      token,
    }: RhqEndpoint): Promise<HandshakeResult> {
      const client = createRhqClient({ ...deps, baseUrl, token });
      // Fresh, not cached: the person pressing the button wants to know
      // whether it works now (a token revoked a minute ago must fail), and
      // the answer refreshes the cache the push step reads.
      const result = await client.handshake({ fresh: true });
      if (!result.ok) {
        const { code, title, detail, status } = result.problem;
        return {
          ok: false,
          problem: { code, title, detail, httpStatus: status },
        };
      }
      const { connection } = result;
      return {
        ok: true,
        connection: {
          id: connection.id,
          name: connection.name,
          currency: connection.currency,
          marketplace: connection.marketplace,
          tokenMode: connection.token.mode,
          tokenExpiresAt: connection.token.expires_at,
        },
      };
    },
  };
}
