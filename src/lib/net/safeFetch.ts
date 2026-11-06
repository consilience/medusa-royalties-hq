import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

import { isIpLiteral, isLocalhostName, isPublicAddress } from "./ipRanges";

// Outbound HTTP to an admin-supplied host (the RHQ API base URL), with the
// publisher's bearer token attached. The URL is typed into the settings page,
// so without these checks it would let anyone with settings access make the
// server request its own network (cloud metadata at 169.254.169.254, an
// internal admin port) and, via Test connection, read the answer back.
//
// Three rules, each closing a way round the one before:
// 1. The address is checked when the socket connects, through the request's
//    own DNS lookup, not by resolving once up front. A separate pre-check
//    could see a public address and the connection a private one moments
//    later (DNS rebinding: a short TTL and a second answer).
// 2. IP literals never reach a lookup (Node connects to them directly), so
//    they are checked before the request starts.
// 3. Redirects are errors. Following one would repeat the request, token
//    included, to wherever the Location header says; RHQ's API never
//    redirects, so a 3xx means the URL is wrong or hostile.
//
// The transport is node:http(s) rather than fetch, because fetch offers no
// connect-time hook without undici, which the plugin does not depend on. A
// per-request `lookup` (net.connect calls it for every connection it opens),
// and the answer is wrapped in a web Response so callers read it the same way.
//
// Two switches relax the checks, each exactly "true": ROYALTIES_HQ_ALLOW_HTTP
// (plain http) and ROYALTIES_HQ_ALLOW_PRIVATE_HOSTS (loopback, private and
// link-local addresses). Production ignores both: a switch left set there
// would reopen exactly the SSRF these checks close.

export interface RhqNetworkPolicy {
  /** Plain http:// is acceptable (the token would travel in clear text). */
  allowHttp: boolean;
  /** Loopback, private, link-local and similar addresses are acceptable. */
  allowPrivate: boolean;
}

export const ALLOW_HTTP_ENV = "ROYALTIES_HQ_ALLOW_HTTP";
export const ALLOW_PRIVATE_HOSTS_ENV = "ROYALTIES_HQ_ALLOW_PRIVATE_HOSTS";

/** The policy for this process, from its environment. */
export function rhqNetworkPolicy(
  env: Record<string, string | undefined> = process.env,
): RhqNetworkPolicy {
  // Exactly "true": an opt-out of a security check should not be triggered
  // by a value someone meant as "off" ("false", "0", "no").
  const production = env.NODE_ENV === "production";
  return {
    allowHttp: !production && env[ALLOW_HTTP_ENV] === "true",
    allowPrivate: !production && env[ALLOW_PRIVATE_HOSTS_ENV] === "true",
  };
}

/** The URL or an address it resolves to is not one the policy allows. */
export class UnsafeDestinationError extends Error {
  name = "UnsafeDestinationError";
}

/** The server answered with a redirect, which is never followed. */
export class UnexpectedRedirectError extends Error {
  name = "UnexpectedRedirectError";
  constructor(readonly status: number) {
    super(
      `The server answered with a redirect (HTTP ${status}); redirects are not followed.`,
    );
  }
}

/** Resolves a hostname to every address it has, as dns.lookup({ all: true }) does. */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/** The slice of fetch's init the RHQ client uses. */
export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export type SafeFetch = (
  input: string | URL,
  init?: SafeFetchInit,
) => Promise<Response>;

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

// The Fetch spec forbids a body on these; Response's constructor throws.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function createSafeFetch({
  policy = rhqNetworkPolicy(),
  resolver = systemResolver,
}: { policy?: RhqNetworkPolicy; resolver?: Resolver } = {}): SafeFetch {
  // net calls this for every connection the request opens, so the address
  // judged is the address connected to.
  const lookup = (
    hostname: string,
    options: { family?: number | string; all?: boolean },
    callback: LookupCallback,
  ) => {
    resolver(hostname)
      .then((answers) => {
        // All answers, not just the one used: Node may fall back to the
        // next address (happy eyeballs), and a name that mixes public and
        // private answers is not a legitimate RHQ install.
        if (!policy.allowPrivate) {
          const bad = answers.find((a) => !isPublicAddress(a.address));
          if (bad) {
            throw new UnsafeDestinationError(
              `${hostname} resolves to a private or local address.`,
            );
          }
        }
        const family = Number(options.family) || 0;
        const usable =
          family === 4 || family === 6
            ? answers.filter((a) => a.family === family)
            : answers;
        if (usable.length === 0) {
          throw Object.assign(new Error(`No address for ${hostname}.`), {
            code: "ENOTFOUND",
          });
        }
        if (options.all) callback(null, usable);
        else callback(null, usable[0]!.address, usable[0]!.family);
      })
      .catch((error: NodeJS.ErrnoException) => callback(error, ""));
  };

  return async function safeFetch(input, init = {}) {
    const url = new URL(input);
    if (
      url.protocol !== "https:" &&
      !(policy.allowHttp && url.protocol === "http:")
    ) {
      throw new UnsafeDestinationError(
        `Only https:// URLs may be requested (got ${url.protocol}).`,
      );
    }
    if (!policy.allowPrivate) {
      // Rule 2: a literal skips the lookup, and "localhost" may be answered
      // from /etc/hosts or by the resolver itself.
      const host = url.hostname;
      if (
        isLocalhostName(host) ||
        (isIpLiteral(host) && !isPublicAddress(host))
      ) {
        throw new UnsafeDestinationError(
          `${host} is a private or local address.`,
        );
      }
    }

    const headers: Record<string, string> = { ...init.headers };
    const body = init.body;
    // A known length rather than chunked encoding, as fetch sends for a
    // string or byte body: some proxies refuse chunked PUTs.
    if (body !== undefined && !hasHeader(headers, "content-length")) {
      headers["Content-Length"] = String(
        typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength,
      );
    }
    const transport = url.protocol === "https:" ? https : http;

    return new Promise<Response>((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: init.method ?? "GET",
          headers,
          signal: init.signal,
          lookup: lookup as unknown as http.RequestOptions["lookup"],
        },
        (message) => {
          const status = message.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            message.destroy();
            reject(new UnexpectedRedirectError(status));
            return;
          }
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(message.headers)) {
            if (value === undefined) continue;
            for (const one of Array.isArray(value) ? value : [value]) {
              responseHeaders.append(name, one);
            }
          }
          // Not read here: the caller reads it through a capped reader, and
          // cancelling that reader destroys the socket.
          const stream = NULL_BODY_STATUSES.has(status)
            ? null
            : (Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>);
          if (stream === null) message.resume();
          try {
            resolve(
              new Response(stream, { status, headers: responseHeaders }),
            );
          } catch (error) {
            // A status Response cannot represent (outside 200-599).
            message.destroy();
            reject(error);
          }
        },
      );
      // The lookup's UnsafeDestinationError arrives here as itself, as do
      // the signal's AbortError and plain socket errors.
      request.on("error", reject);
      request.end(body === undefined ? undefined : body);
    });
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

let processSafeFetch: SafeFetch | undefined;

/**
 * The process-wide safeFetch, under this process's policy. Built on first
 * use so a test (or a script) can set the environment first.
 */
export const safeFetch: SafeFetch = (input, init) => {
  processSafeFetch ??= createSafeFetch();
  return processSafeFetch(input, init);
};
