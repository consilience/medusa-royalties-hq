import {
  fnv1a32,
  JITTER_BASE_MINUTES,
  JITTER_SPAN_MINUTES,
  pushOffsetMinutes,
} from "../../period";

describe("fnv1a32", () => {
  // Published FNV-1a 32-bit test vectors, so the hash is the real FNV-1a and
  // not an accidental variant.
  it.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["foobar", 0xbf9cf968],
  ])("hashes %j", (s, expected) => {
    expect(fnv1a32(s)).toBe(expected);
  });

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    // An independent reference over explicit bytes: "é" is C3 A9 in UTF-8,
    // whereas hashing its UTF-16 code unit would feed the single value E9.
    const ref = (bytes: number[]) => {
      let h = 0x811c9dc5;
      for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
      return h;
    };
    expect(fnv1a32("é")).toBe(ref([0xc3, 0xa9]));
    expect(fnv1a32("é")).not.toBe(ref([0xe9]));
  });
});

describe("pushOffsetMinutes", () => {
  it("is between 01:00 and 05:59 after the cut-off", () => {
    expect(JITTER_BASE_MINUTES).toBe(60);
    expect(JITTER_SPAN_MINUTES).toBe(300);
    for (let i = 0; i < 500; i++) {
      const m = pushOffsetMinutes(`shop-${i}.example.com`);
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(60);
      expect(m).toBeLessThanOrEqual(359);
    }
  });

  it("is stable for a shop and ignores case and surrounding space", () => {
    const a = pushOffsetMinutes("poppy-press.example.com");
    expect(pushOffsetMinutes("poppy-press.example.com")).toBe(a);
    expect(pushOffsetMinutes(" Poppy-Press.Example.com ")).toBe(a);
  });

  it("is pinned: changing the hash would move every shop's push minute", () => {
    expect(pushOffsetMinutes("poppy-press.example.com")).toBe(
      PINNED_POPPY_PRESS,
    );
  });

  it("spreads shops across the window", () => {
    const n = 3000;
    const hours = [0, 0, 0, 0, 0];
    const distinct = new Set<number>();
    for (let i = 0; i < n; i++) {
      const m = pushOffsetMinutes(`store-${i}.example.com`);
      distinct.add(m);
      hours[(m - 60 - ((m - 60) % 60)) / 60]! += 1;
    }
    // A uniform spread puts 20% in each hour; allow generous slack.
    for (const h of hours) {
      expect(h / n).toBeGreaterThan(0.15);
      expect(h / n).toBeLessThan(0.25);
    }
    expect(distinct.size).toBeGreaterThanOrEqual(280);
  });

  it("refuses an empty domain rather than bunching every misconfigured shop together", () => {
    expect(() => pushOffsetMinutes("   ")).toThrow();
  });
});

// FNV-1a + murmur3 fmix32, mod 300, worked out independently of the code.
const PINNED_POPPY_PRESS = 357;
