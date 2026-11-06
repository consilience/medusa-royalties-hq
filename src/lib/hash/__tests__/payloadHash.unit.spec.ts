import { createHash } from "node:crypto";
import { canonicalJson } from "../../../core/payload";
import {
  payloadHash,
  withPushedGeneratedAt,
} from "../payloadHash";

describe("payloadHash", () => {
  it("is the SHA-256 hex of the canonical JSON", () => {
    const payload = { b: "1.00", a: [1, 2] };
    expect(payloadHash(payload)).toBe(
      createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
    );
    expect(payloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on key insertion order", () => {
    expect(payloadHash({ a: 1, b: { c: "x", d: null } })).toBe(
      payloadHash({ b: { d: null, c: "x" }, a: 1 }),
    );
  });

  it("changes when any value changes", () => {
    expect(payloadHash({ a: "1.00" })).not.toBe(payloadHash({ a: "1.0" }));
  });

  it("hashes non-ASCII titles as UTF-8", () => {
    const payload = { title: "東京物語" };
    expect(payloadHash(payload)).toBe(
      createHash("sha256")
        .update(Buffer.from('{"title":"東京物語"}', "utf8"))
        .digest("hex"),
    );
  });
});

describe("payloadHash is a content hash", () => {
  // RHQ answers "same bytes → 200 unchanged", and the edge skips a re-push
  // whose hash matches the last one. generated_at changes on every build, so
  // a hash that included it would change on every build too, and neither
  // check could ever fire.
  const base = {
    schema_version: 1,
    period: "2026-08",
    generated_at: "2026-09-20T02:00:00Z",
    rows: [{ royalty_on_sales: "10.00" }],
  };

  it("ignores generated_at", () => {
    expect(payloadHash({ ...base, generated_at: "2026-09-21T02:00:00Z" })).toBe(
      payloadHash(base),
    );
  });

  it("changes when any other content changes", () => {
    expect(
      payloadHash({ ...base, rows: [{ royalty_on_sales: "10.01" }] }),
    ).not.toBe(payloadHash(base));
    expect(payloadHash({ ...base, period: "2026-07" })).not.toBe(
      payloadHash(base),
    );
  });

  it("only drops the top-level generated_at", () => {
    expect(payloadHash({ ...base, rows: [{ generated_at: "a" }] })).not.toBe(
      payloadHash({ ...base, rows: [{ generated_at: "b" }] }),
    );
  });
});

describe("withPushedGeneratedAt", () => {
  const pushed = {
    period: "2026-08",
    generated_at: "2026-09-20T02:00:00Z",
    rows: [{ royalty_on_sales: "10.00" }],
  };

  it("reuses the pushed generated_at when the content is unchanged, so the bytes are identical", () => {
    const rebuilt = { ...pushed, generated_at: "2026-09-21T02:00:00Z" };
    const body = withPushedGeneratedAt(rebuilt, {
      hash: payloadHash(pushed),
      generatedAt: pushed.generated_at,
    });
    expect(canonicalJson(body)).toBe(canonicalJson(pushed));
  });

  it("keeps the new generated_at when the content changed", () => {
    const rebuilt = {
      ...pushed,
      generated_at: "2026-09-21T02:00:00Z",
      rows: [{ royalty_on_sales: "9.00" }],
    };
    expect(
      withPushedGeneratedAt(rebuilt, {
        hash: payloadHash(pushed),
        generatedAt: pushed.generated_at,
      }).generated_at,
    ).toBe("2026-09-21T02:00:00Z");
  });

  it("keeps the new generated_at when nothing was pushed before", () => {
    expect(withPushedGeneratedAt(pushed, null)).toBe(pushed);
  });
});
