
import { isPublicAddress } from "../ipRanges";

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:c0a8:0101",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    // The rest of IANA's special-purpose registries.
    "192.0.0.1", // IETF protocol assignments 192.0.0.0/24
    "192.0.0.170",
    "192.0.2.1", // TEST-NET-1
    "192.88.99.1", // 6to4 relay anycast (deprecated)
    "198.18.0.1", // benchmarking 198.18.0.0/15
    "198.19.255.255",
    "198.51.100.1", // TEST-NET-2
    "203.0.113.1", // TEST-NET-3
    "::ffff:0:7f00:1", // IPv4-translated ::ffff:0:0:0/96
    "::ffff:0:10.0.0.1",
    "64:ff9b::a00:1", // NAT64 well-known prefix, private IPv4 inside
    "64:ff9b:1::a00:1", // local-use NAT64 64:ff9b:1::/48, always refused
    "64:ff9b:1::808:808",
    "2002:a00:1::", // 6to4 of 10.0.0.1
    "2002:c0a8:101::1", // 6to4 of 192.168.1.1
    "2001::1", // Teredo 2001::/32 (the client IPv4 is obfuscated)
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:2::1", // benchmarking, inside IETF 2001::/23
    "2001:10::1", // ORCHID
    "2001:db8::1", // documentation
    "3fff::1", // documentation 3fff::/20
    "::8.8.8.8", // IPv4-compatible: deprecated, never routed
    "100::1", // discard-only 100::/64
    // Only global unicast 2000::/3 is allowed; everything else is refused.
    "fec0::1", // site-local fec0::/10 (deprecated but still routed internally)
    "feff::1",
    "1000::1",
    "4000::1",
    "5f00::1", // SRv6 SIDs
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.169.0.1",
    "2606:4700::1111",
    "2a00:1450:4009:81f::200e",
    "::ffff:8.8.8.8",
    "198.17.255.255",
    "198.20.0.0",
    "192.0.1.1",
    "203.0.114.1",
    "2001:4860:4860::8888", // 2001: outside the IETF /23
    "2002:808:808::1", // 6to4 of a public address
    "64:ff9b::808:808", // NAT64 of a public address
    "3fff:1000::1", // just past 3fff::/20
  ])("accepts %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("refuses anything that is not an IP address", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
    expect(isPublicAddress("1.2.3")).toBe(false);
    expect(isPublicAddress("1:2:3")).toBe(false);
  });
});
