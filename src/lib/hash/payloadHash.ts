import { createHash } from "node:crypto";
import { canonicalJson } from "../../core/payload";

/**
 * Content hash (SHA-256 hex) of a payload: the canonical JSON with the
 * top-level `generated_at` removed.
 *
 * Why without generated_at: it is a clock reading and changes on every build,
 * so a hash over it would differ for two snapshots with identical data. Two
 * things depend on "same data → same hash": the edge's skip-identical-repush
 * check, and RHQ's "same bytes → 200 unchanged" answer. Only the top level is
 * dropped; the key is not special anywhere else in the payload.
 *
 * Kept out of src/core because the core may not import Node modules; the
 * core's job is to make the serialisation canonical, and hashing that string
 * is all this does.
 *
 * **Edge contract.** Because generated_at is outside the hash, equal hashes do
 * not by themselves mean equal bytes. When the content hash of a rebuilt
 * snapshot equals the last pushed one, the edge must send the previously
 * pushed generated_at (use `withPushedGeneratedAt`), or simply re-send the
 * stored bytes, so RHQ sees byte-identical input and answers "unchanged"
 * rather than recording a new version whose only difference is a timestamp.
 * Send canonicalJson(body) as the request body.
 */
export function payloadHash(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(withoutGeneratedAt(payload)), "utf8")
    .digest("hex");
}

/** What the snapshot log recorded for the last successful push of a period. */
export interface PushedSnapshotRef {
  hash: string;
  generatedAt: string;
}

/**
 * The payload to send: unchanged content keeps the generated_at it was first
 * pushed with (so the bytes match the earlier push exactly); changed content,
 * or a first push, keeps the new one.
 */
export function withPushedGeneratedAt<T extends { generated_at: string }>(
  payload: T,
  previous: PushedSnapshotRef | null,
): T {
  if (previous === null || payloadHash(payload) !== previous.hash) {
    return payload;
  }
  return { ...payload, generated_at: previous.generatedAt };
}

function withoutGeneratedAt(payload: unknown): unknown {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("generated_at" in payload)
  ) {
    return payload;
  }
  // Setting it to undefined rather than deleting keeps the caller's object
  // untouched; canonicalJson drops undefined members, as JSON.stringify does.
  return { ...payload, generated_at: undefined };
}
