// Which IP addresses the app may send an RHQ request (and so the publisher's
// token) to. Pure and dependency-free so settings validation can use it for
// a literal host, and safeFetch for every address DNS returns at connect time.
//
// Hand-rolled rather than node:net's BlockList because the dangerous cases
// are the encodings: an IPv4 address wrapped in IPv6 (::ffff:127.0.0.1,
// which URL parsing rewrites to ::ffff:7f00:1, or NAT64/6to4 forms) reaches
// the IPv4 host, so it must be judged by the IPv4 address inside it.

/**
 * [first address, prefix length] of IPv4 ranges that are never an RHQ
 * install: every block in IANA's IPv4 Special-Purpose Address Registry that
 * is not plain global unicast. Documentation and benchmarking ranges are not "dangerous"
 * as such, but nothing legitimate lives there and some networks route them
 * internally, so they are refused rather than reasoned about.
 */
const BLOCKED_V4: [number, number][] = [
  [v4("0.0.0.0"), 8], // "this network"; 0.0.0.0 reaches localhost on Linux
  [v4("10.0.0.0"), 8], // private
  [v4("100.64.0.0"), 10], // carrier-grade NAT (often a cloud's internal net)
  [v4("127.0.0.0"), 8], // loopback
  [v4("169.254.0.0"), 16], // link-local, including cloud metadata endpoints
  [v4("172.16.0.0"), 12], // private
  [v4("192.0.0.0"), 24], // IETF protocol assignments (incl. 192.0.0.170 NAT64 discovery)
  [v4("192.0.2.0"), 24], // TEST-NET-1
  [v4("192.88.99.0"), 24], // 6to4 relay anycast (deprecated, RFC 7526)
  [v4("192.168.0.0"), 16], // private
  [v4("198.18.0.0"), 15], // benchmarking; often used for internal test nets
  [v4("198.51.100.0"), 24], // TEST-NET-2
  [v4("203.0.113.0"), 24], // TEST-NET-3
  [v4("224.0.0.0"), 4], // multicast
  [v4("240.0.0.0"), 4], // reserved, and the broadcast address
];

function v4(dotted: string): number {
  const value = parseV4(dotted);
  if (value === null) throw new Error(`bad IPv4 constant ${dotted}`);
  return value;
}

function parseV4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function parseV6(text: string): number[] | null {
  // A zone id (fe80::1%eth0) names an interface, not a different address.
  const address = text.replace(/%.*$/, "");
  if (!address.includes(":")) return null;
  let tail: number[] = [];
  let body = address;
  // A trailing dotted IPv4 part fills the last two groups.
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) {
    const value = parseV4(dotted[1]!);
    if (value === null) return null;
    tail = [Math.floor(value / 65536), value % 65536];
    body = address.slice(0, address.length - dotted[1]!.length);
    if (body.endsWith(":") && !body.endsWith("::")) body = body.slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const group = (part: string) =>
    part === ""
      ? []
      : part
          .split(":")
          .map((g) =>
            /^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : Number.NaN,
          );
  const head = group(halves[0]!);
  const rest = halves.length === 2 ? group(halves[1]!) : [];
  const known = head.length + rest.length + tail.length;
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1) {
    return known === 8 ? [...head, ...tail] : null;
  }
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

function v4Blocked(value: number): boolean {
  return BLOCKED_V4.some(([base, prefix]) => {
    const size = 2 ** (32 - prefix);
    return Math.floor(value / size) === Math.floor(base / size);
  });
}

// IPv6 is judged by allow-list rather than block-list 
// only global unicast 2000::/3 can be an RHQ install, so everything outside
// it (loopback, link-local, site-local fec0::/10, unique local, multicast,
// discard 100::/64, and any range IANA assigns later) is refused without
// having to be named. The forms that carry an IPv4 address a host or
// gateway will actually connect to are judged by that address instead.
function v6Blocked(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embedded = (hi: number, lo: number) => v4Blocked(hi * 65536 + lo);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    // IPv4-mapped ::ffff:a.b.c.d: the OS connects to the IPv4 host.
    if (g4 === 0 && g5 === 0xffff) return embedded(g6, g7);
    // IPv4-translated ::ffff:0:a.b.c.d (RFC 2765 SIIT): a translator
    // forwards it to the IPv4 host.
    if (g4 === 0xffff && g5 === 0) return embedded(g6, g7);
    // Everything else in ::/64, including :: (unspecified), ::1
    // (loopback) and the deprecated IPv4-compatible ::a.b.c.d, which no
    // public host uses.
    return true;
  }
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): a public gateway
  // forwards it to the embedded IPv4 address.
  if (
    g0 === 0x64 &&
    g1 === 0xff9b &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0
  ) {
    return embedded(g6, g7);
  }
  // Local-use NAT64 64:ff9b:1::/48 (RFC 8215) is outside 2000::/3 and so
  // refused below whatever it embeds: its translator is by definition
  // inside someone's network, and the IPv4 address may sit at any of
  // several offsets.
  if ((g0 & 0xe000) !== 0x2000) return true;
  // 6to4 2002::/16: a relay forwards to the IPv4 address in bits 16-47.
  if (g0 === 0x2002) return embedded(g1, g2);
  // IETF protocol assignments 2001::/23: Teredo 2001::/32 (whose client
  // IPv4 address is obfuscated, so it cannot be judged), benchmarking,
  // ORCHID and a few anycast services. No RHQ install lives there.
  if (g0 === 0x2001 && g1 < 0x0200) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x3fff && g1 < 0x1000) return true; // documentation 3fff::/20
  return false;
}

/**
 * True only for an IP address that is safe to send the RHQ token to: not
 * loopback, private, link-local, CGNAT, multicast or reserved, in either
 * family or any IPv6 wrapping of IPv4. Anything that is not an IP address
 * at all is false, so a caller can never mistake "not checked" for "safe".
 */
export function isPublicAddress(address: string): boolean {
  const asV4 = parseV4(address);
  if (asV4 !== null) return !v4Blocked(asV4);
  const asV6 = parseV6(address.replace(/^\[|\]$/g, ""));
  if (asV6 !== null) return !v6Blocked(asV6);
  return false;
}

/** Whether a URL hostname is an IP literal (IPv6 in brackets, as URL gives it). */
export function isIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return parseV4(bare) !== null || parseV6(bare) !== null;
}

/**
 * Hostnames that name this machine without DNS: "localhost" and anything
 * under .localhost resolve to loopback by convention (RFC 6761), whatever a
 * resolver says.
 */
export function isLocalhostName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}
