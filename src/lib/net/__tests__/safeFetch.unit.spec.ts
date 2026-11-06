import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createSafeFetch,
  rhqNetworkPolicy,
  UnsafeDestinationError,
  type Resolver,
} from "../safeFetch";

// A real local HTTP server stands in for "a host on the private network":
// the fake resolver maps made-up public-looking names onto it, which is
// exactly what DNS rebinding does, so the tests prove the check happens on
// the address actually connected to rather than on a separate lookup.

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/hang") return; // never answers
    if (req.url === "/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            headers: req.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function fakeResolver(answers: Record<string, string[]>) {
  const asked: string[] = [];
  const resolver: Resolver = async (hostname) => {
    asked.push(hostname);
    const addresses = answers[hostname];
    if (!addresses)
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
  return { resolver, asked };
}

const strict = { allowHttp: true, allowPrivate: false };
const local = { allowHttp: true, allowPrivate: true };

describe("safeFetch", () => {
  it("refuses a name that resolves to a private address, at connect time", async () => {
    const { resolver, asked } = fakeResolver({
      "rhq.example": ["127.0.0.1"],
    });
    const safeFetch = createSafeFetch({ policy: strict, resolver });
    const error = await safeFetch(`http://rhq.example:${port}/`).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnsafeDestinationError);
    expect(asked).toEqual(["rhq.example"]);
  });

  it("refuses when any of the resolved addresses is private", async () => {
    const { resolver } = fakeResolver({
      "rhq.example": ["93.184.216.34", "10.0.0.5"],
    });
    const safeFetch = createSafeFetch({ policy: strict, resolver });
    await expect(
      safeFetch(`http://rhq.example:${port}/`),
    ).rejects.toBeInstanceOf(UnsafeDestinationError);
  });

  it("refuses an IPv4-mapped IPv6 loopback answer", async () => {
    const { resolver } = fakeResolver({ "rhq.example": ["::ffff:127.0.0.1"] });
    const safeFetch = createSafeFetch({ policy: strict, resolver });
    await expect(
      safeFetch(`http://rhq.example:${port}/`),
    ).rejects.toBeInstanceOf(UnsafeDestinationError);
  });

  it("refuses a private IP literal without resolving anything", async () => {
    const { resolver, asked } = fakeResolver({});
    const safeFetch = createSafeFetch({ policy: strict, resolver });
    await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(
      UnsafeDestinationError,
    );
    await expect(
      safeFetch(`http://[::ffff:7f00:1]:${port}/`),
    ).rejects.toBeInstanceOf(UnsafeDestinationError);
    expect(asked).toEqual([]);
  });

  it("refuses plain http unless allowed", async () => {
    const { resolver } = fakeResolver({ "rhq.example": ["93.184.216.34"] });
    const safeFetch = createSafeFetch({
      policy: { allowHttp: false, allowPrivate: false },
      resolver,
    });
    await expect(safeFetch("http://rhq.example/api/v1")).rejects.toBeInstanceOf(
      UnsafeDestinationError,
    );
  });

  it("connects through the resolver's answer when the policy allows private hosts", async () => {
    const { resolver, asked } = fakeResolver({
      "rhq.example": ["127.0.0.1"],
    });
    const safeFetch = createSafeFetch({ policy: local, resolver });
    const response = await safeFetch(`http://rhq.example:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(asked).toEqual(["rhq.example"]);
  });

  it("treats a redirect as an error rather than following it", async () => {
    const { resolver } = fakeResolver({ "rhq.example": ["127.0.0.1"] });
    const safeFetch = createSafeFetch({ policy: local, resolver });
    await expect(
      safeFetch(`http://rhq.example:${port}/redirect`),
    ).rejects.toThrow(/redirect/i);
  });
});

// Two switches, each relaxing one check, with the value `true`. NODE_ENV=
// development relaxes nothing: `medusa develop` sets it for every local
// store, so only an explicit switch may.
// The transport is node:http(s) with a connect-time lookup, not fetch. These pin what
// the client relies on from it.
describe("safeFetch over node:http", () => {
  it("sends the method, headers and exact body, with a Content-Length", async () => {
    const { resolver } = fakeResolver({ "rhq.example": ["127.0.0.1"] });
    const safeFetch = createSafeFetch({ policy: local, resolver });
    const body = '{"name":"Poppy’s Promise"}';
    const response = await safeFetch(`http://rhq.example:${port}/echo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body,
    });
    const echoed = (await response.json()) as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(echoed.method).toBe("PUT");
    expect(echoed.body).toBe(body);
    expect(echoed.headers["content-type"]).toBe("application/json");
    expect(echoed.headers.authorization).toBe("Bearer t");
    expect(echoed.headers["content-length"]).toBe(
      String(Buffer.byteLength(body, "utf8")),
    );
    expect(echoed.headers["transfer-encoding"]).toBeUndefined();
  });

  it("exposes the answer's status and headers", async () => {
    const { resolver } = fakeResolver({ "rhq.example": ["127.0.0.1"] });
    const safeFetch = createSafeFetch({ policy: local, resolver });
    const response = await safeFetch(`http://rhq.example:${port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.body).not.toBeNull();
  });

  it("aborts on the caller's signal", async () => {
    const { resolver } = fakeResolver({ "rhq.example": ["127.0.0.1"] });
    const safeFetch = createSafeFetch({ policy: local, resolver });
    const error = await safeFetch(`http://rhq.example:${port}/hang`, {
      signal: AbortSignal.timeout(50),
    }).catch((e: unknown) => e);
    expect(["AbortError", "TimeoutError"]).toContain(
      (error as { name?: string }).name,
    );
  });
});

describe("rhqNetworkPolicy", () => {
  it("is strict in production, in development and by default", () => {
    const strict = { allowHttp: false, allowPrivate: false };
    expect(rhqNetworkPolicy({ NODE_ENV: "production" })).toEqual(strict);
    expect(rhqNetworkPolicy({ NODE_ENV: "development" })).toEqual(strict);
    expect(rhqNetworkPolicy({})).toEqual(strict);
  });

  it("allows private hosts only with ROYALTIES_HQ_ALLOW_PRIVATE_HOSTS=true", () => {
    expect(
      rhqNetworkPolicy({
        NODE_ENV: "test",
        ROYALTIES_HQ_ALLOW_PRIVATE_HOSTS: "true",
      }),
    ).toEqual({ allowHttp: false, allowPrivate: true });
  });

  it("allows plain http only with ROYALTIES_HQ_ALLOW_HTTP=true", () => {
    expect(rhqNetworkPolicy({ ROYALTIES_HQ_ALLOW_HTTP: "true" })).toEqual({
      allowHttp: true,
      allowPrivate: false,
    });
    expect(
      rhqNetworkPolicy({
        ROYALTIES_HQ_ALLOW_HTTP: "true",
        ROYALTIES_HQ_ALLOW_PRIVATE_HOSTS: "true",
      }),
    ).toEqual({ allowHttp: true, allowPrivate: true });
  });

  // Exactly "true": an opt-out of a security check should not be triggered
  // by a value someone meant some other way.
  it("ignores any other value", () => {
    for (const value of ["1", "yes", "TRUE", " true", "false", ""]) {
      expect(
        rhqNetworkPolicy({
          ROYALTIES_HQ_ALLOW_HTTP: value,
          ROYALTIES_HQ_ALLOW_PRIVATE_HOSTS: value,
        }),
      ).toEqual({ allowHttp: false, allowPrivate: false });
    }
  });

  // The switches are for a local end-to-end
  // run. A production server with one left set would let a settings URL
  // reach cloud metadata and internal ports, so production ignores them.
  it("ignores both switches when NODE_ENV is production", () => {
    expect(
      rhqNetworkPolicy({
        NODE_ENV: "production",
        ROYALTIES_HQ_ALLOW_HTTP: "true",
        ROYALTIES_HQ_ALLOW_PRIVATE_HOSTS: "true",
      }),
    ).toEqual({ allowHttp: false, allowPrivate: false });
  });
});
