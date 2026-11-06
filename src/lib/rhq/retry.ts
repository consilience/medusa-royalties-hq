// When to try an RHQ request again.
//
// A pure function rather than a loop inside the client: pushes run from the
// scheduled job, and a wait can be an hour or more, so the caller persists the
// attempt state and schedules the next run itself. Keeping the decision pure
// (clock and randomness passed in) also means every branch is testable
// without sleeping.

/** What the caller persists between attempts of one logical request. */
export interface RetryState {
  /** When the first attempt was made; the 24 h budget runs from here. */
  firstAttemptAt: Date;
  /** Attempts made so far, including the one that just failed (≥ 1). */
  attempts: number;
}

/**
 * The failed attempt, as the client reports it (RhqProblem carries these
 * fields). `status` is null for local failures that never got an HTTP answer.
 */
export interface AttemptOutcome {
  code: string;
  status: number | null;
  retryAfterSeconds?: number | null;
}

export type RetryDecision =
  { retryAt: Date } | { giveUp: true; reason: "not_retryable" | "deadline" };

export const BASE_DELAY_MS = 30_000;
export const MAX_WAIT_MS = 60 * 60_000;
export const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
// Full jitter can draw zero; a floor keeps a burst of failures from
// becoming a hot loop against a struggling server.
const MIN_WAIT_MS = 1_000;
// Retry-After: 0 (or 1) is legal, but a job rescheduled for "now" goes
// straight back to a server that has just said it is overloaded, and a
// worker polling every few seconds would turn a run of them into a tight
// loop. Five seconds costs nothing against a monthly push.
const MIN_RETRY_AFTER_MS = 5_000;

/**
 * Answers that retrying the same request cannot change. Each needs a person
 * (fix the data, undo an import in RHQ, rotate the token, fix the URL) or
 * the calendar (period_not_ended: the scheduler pushes after month end
 * anyway, and backing off for 24 h would only hide a clock problem).
 * period_committed especially: RHQ says "do not retry automatically".
 */
export const NEVER_RETRY_CODES: ReadonlySet<string> = new Set([
  "period_committed",
  "validation_failed",
  "duplicate_period",
  "period_not_ended",
  "unauthenticated",
  "forbidden",
  "https_required",
  "payload_too_large",
  "unsupported_media_type",
  "malformed_json",
  "bad_request",
  // Local refusals from safeFetch: the configured URL is private, not
  // https, or redirects. It will still be wrong in an hour.
  "unsafe_destination",
  "unexpected_redirect",
  // An answer over 1 MiB is not RHQ's; the URL points
  // somewhere else, and will an hour from now too.
  "response_too_large",
  // The token is for another platform's connection, or the connection is
  // bound to another store: a person fixes the connection.
  "platform_mismatch",
  "store_mismatch",
]);

// Codes whose Retry-After is a promise from RHQ about when to come back.
// RHQ promises nothing about Retry-After on anything else, so it is ignored
// in favour of our own backoff rather than trusted blindly.
const RETRY_AFTER_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "service_unavailable",
  "snapshot_in_progress",
]);

// Known transient failures. Local ones (no HTTP answer) have a null status,
// so they cannot be judged by status and are listed.
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "service_unavailable",
  "snapshot_in_progress",
  "server_error",
  "network_error",
  "timeout",
]);

function isRetryable(outcome: AttemptOutcome): boolean {
  if (NEVER_RETRY_CODES.has(outcome.code)) return false;
  if (RETRYABLE_CODES.has(outcome.code)) return true;
  // An unknown code is treated by its HTTP status. Only server
  // trouble, throttling and request timeouts are worth another go; any other
  // 4xx says the request itself is wrong. Also how a non-problem body
  // (unexpected_response, e.g. a proxy's HTML 502) is judged.
  const s = outcome.status;
  if (s === null) return false;
  return s >= 500 || s === 429 || s === 408;
}

export function nextAttempt(
  state: RetryState,
  outcome: AttemptOutcome,
  now: Date,
  random: () => number = Math.random,
): RetryDecision {
  if (!isRetryable(outcome)) return { giveUp: true, reason: "not_retryable" };

  const deadline = state.firstAttemptAt.getTime() + GIVE_UP_AFTER_MS;
  const nowMs = now.getTime();
  if (nowMs >= deadline) return { giveUp: true, reason: "deadline" };

  const retryAfter = outcome.retryAfterSeconds;
  if (
    RETRY_AFTER_CODES.has(outcome.code) &&
    typeof retryAfter === "number" &&
    Number.isFinite(retryAfter) &&
    retryAfter >= 0
  ) {
    // Honoured exactly, even past the hourly cap: retrying before RHQ said
    // to only earns another refusal (and counts towards the limit). If the
    // promised time is past our budget, surface the error now rather than
    // make one last attempt we already know is too early.
    const retryAt = nowMs + Math.max(retryAfter * 1000, MIN_RETRY_AFTER_MS);
    if (retryAt > deadline) return { giveUp: true, reason: "deadline" };
    return { retryAt: new Date(retryAt) };
  }

  // Full jitter (uniform over [0, cap]) rather than equal or decorrelated
  // jitter: many stores share one RHQ install and push on the same day, and
  // full jitter spreads a synchronised failure out the most.
  const exponent = Math.max(0, state.attempts - 1);
  const cap = Math.min(
    MAX_WAIT_MS,
    BASE_DELAY_MS * 2 ** Math.min(exponent, 30),
  );
  const wait = Math.max(MIN_WAIT_MS, Math.floor(random() * cap));
  // A backoff wait is ours to choose, so the last one is shortened to land
  // on the deadline: one final attempt, then the next failure gives up.
  return { retryAt: new Date(Math.min(nowMs + wait, deadline)) };
}
