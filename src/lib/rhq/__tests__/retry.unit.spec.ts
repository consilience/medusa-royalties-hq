
import {
  BASE_DELAY_MS,
  GIVE_UP_AFTER_MS,
  MAX_WAIT_MS,
  nextAttempt,
  NEVER_RETRY_CODES,
  type AttemptOutcome,
  type RetryState,
} from "../retry";

// The policy is a pure function of (state, outcome, now, random), so every
// branch is pinned here with fixed clocks and fixed "random" draws rather
// than by sleeping or sampling.

const T0 = Date.parse("2026-10-15T03:00:00Z");
const at = (ms: number) => new Date(T0 + ms);
const first: RetryState = { firstAttemptAt: new Date(T0), attempts: 1 };

function problem(
  code: string,
  status: number | null,
  retryAfterSeconds: number | null = null,
): AttemptOutcome {
  return { code, status, retryAfterSeconds };
}

const HOUR = 3_600_000;

describe("nextAttempt: never retried", () => {
  it.each([...NEVER_RETRY_CODES])("%s gives up at once", (code) => {
    const decision = nextAttempt(first, problem(code, 422), at(0), () => 0.5);
    expect(decision).toEqual({ giveUp: true, reason: "not_retryable" });
  });

  it("covers every code that is final", () => {
    expect([...NEVER_RETRY_CODES].sort()).toEqual(
      [
        "bad_request",
        "duplicate_period",
        "forbidden",
        "https_required",
        "malformed_json",
        "payload_too_large",
        "period_committed",
        "period_not_ended",
        "unauthenticated",
        "unsupported_media_type",
        "validation_failed",
        // Local refusals: the URL itself is wrong, so waiting cannot help.
        "unexpected_redirect",
        "unsafe_destination",
        // Over 1 MiB: not an RHQ answer, so the URL is wrong.
        "response_too_large",
        // The connection is for another platform or bound to another store
        // A person must fix it.
        "platform_mismatch",
        "store_mismatch",
      ].sort(),
    );
  });

  it("period_committed is final even when RHQ sends Retry-After", () => {
    const decision = nextAttempt(
      first,
      problem("period_committed", 409, 60),
      at(0),
      () => 0.5,
    );
    expect(decision).toEqual({ giveUp: true, reason: "not_retryable" });
  });
});

describe("nextAttempt: Retry-After", () => {
  it.each([
    ["rate_limited", 429],
    ["service_unavailable", 503],
    ["snapshot_in_progress", 409],
  ])("%s waits exactly Retry-After", (code, status) => {
    const decision = nextAttempt(
      first,
      problem(code, status, 120),
      at(5_000),
      () => 0.99,
    );
    expect(decision).toEqual({ retryAt: at(5_000 + 120_000) });
  });

  it.each([0, 1, 4])(
    "a Retry-After of %s s still waits at least 5 s",
    (seconds) => {
      const decision = nextAttempt(
        first,
        problem("rate_limited", 429, seconds),
        at(0),
        () => 0.99,
      );
      expect(decision).toEqual({ retryAt: at(5_000) });
    },
  );

  it("a Retry-After longer than an hour is still honoured", () => {
    // The daily row allowance answers 429 with the seconds until it
    // resets; retrying sooner only earns another 429.
    const decision = nextAttempt(
      first,
      problem("rate_limited", 429, 5 * 3600),
      at(0),
      () => 0,
    );
    expect(decision).toEqual({ retryAt: at(5 * HOUR) });
  });

  it("gives up when Retry-After lands beyond the 24 h window", () => {
    const decision = nextAttempt(
      first,
      problem("rate_limited", 429, 3600),
      at(GIVE_UP_AFTER_MS - 60_000),
      () => 0,
    );
    expect(decision).toEqual({ giveUp: true, reason: "deadline" });
  });

  it("ignores Retry-After on codes that do not promise it (server_error backs off)", () => {
    const decision = nextAttempt(
      first,
      problem("server_error", 500, 1),
      at(0),
      () => 0.5,
    );
    expect(decision).toEqual({ retryAt: at(BASE_DELAY_MS * 0.5) });
  });

  it("a 503 without Retry-After backs off instead", () => {
    const decision = nextAttempt(
      first,
      problem("service_unavailable", 503, null),
      at(0),
      () => 0.25,
    );
    expect(decision).toEqual({ retryAt: at(BASE_DELAY_MS * 0.25) });
  });
});

describe("nextAttempt: full-jitter exponential backoff", () => {
  it("draws uniformly from [0, base × 2^(attempts−1)]", () => {
    const third: RetryState = { ...first, attempts: 3 };
    expect(
      nextAttempt(third, problem("network_error", null), at(0), () => 1),
    ).toEqual({ retryAt: at(BASE_DELAY_MS * 4) });
    expect(
      nextAttempt(third, problem("network_error", null), at(0), () => 0.5),
    ).toEqual({ retryAt: at(BASE_DELAY_MS * 2) });
  });

  it("never waits less than a second, so a zero draw is not a hot loop", () => {
    expect(
      nextAttempt(first, problem("timeout", null), at(0), () => 0),
    ).toEqual({ retryAt: at(1_000) });
  });

  it("caps each wait at one hour", () => {
    const many: RetryState = { ...first, attempts: 40 };
    expect(
      nextAttempt(many, problem("server_error", 500), at(0), () => 1),
    ).toEqual({ retryAt: at(MAX_WAIT_MS) });
    expect(MAX_WAIT_MS).toBe(HOUR);
  });

  it("clamps the last backoff to the 24 h deadline, then gives up", () => {
    const late: RetryState = { ...first, attempts: 30 };
    const now = at(GIVE_UP_AFTER_MS - 10 * 60_000);
    expect(
      nextAttempt(late, problem("server_error", 500), now, () => 1),
    ).toEqual({ retryAt: at(GIVE_UP_AFTER_MS) });
    expect(
      nextAttempt(
        late,
        problem("server_error", 500),
        at(GIVE_UP_AFTER_MS),
        () => 1,
      ),
    ).toEqual({ giveUp: true, reason: "deadline" });
  });

  it.each([
    ["network_error", null],
    ["timeout", null],
    ["server_error", 500],
    ["rate_limited", 429],
  ])("%s is retryable", (code, status) => {
    expect(
      "retryAt" in nextAttempt(first, problem(code, status), at(0), () => 0.5),
    ).toBe(true);
  });
});

describe("nextAttempt: codes it does not know", () => {
  // RHQ can add codes, so an unknown one is judged by its HTTP status.
  it.each([500, 502, 504, 429, 408])("retries an unknown code on %i", (s) => {
    expect(
      "retryAt" in nextAttempt(first, problem("brand_new", s), at(0), () => 0),
    ).toBe(true);
  });

  it.each([400, 404, 405, 410, 422])("gives up on an unknown %i", (s) => {
    expect(nextAttempt(first, problem("brand_new", s), at(0), () => 0)).toEqual(
      { giveUp: true, reason: "not_retryable" },
    );
  });

  it("an unexpected_response is judged by its status", () => {
    expect(
      "retryAt" in
        nextAttempt(first, problem("unexpected_response", 502), at(0), () => 0),
    ).toBe(true);
    expect(
      nextAttempt(first, problem("unexpected_response", 200), at(0), () => 0),
    ).toEqual({ giveUp: true, reason: "not_retryable" });
  });

  it("snapshot_not_found and not_found are final", () => {
    for (const code of ["snapshot_not_found", "not_found"]) {
      expect(nextAttempt(first, problem(code, 404), at(0), () => 0)).toEqual({
        giveUp: true,
        reason: "not_retryable",
      });
    }
  });
});
