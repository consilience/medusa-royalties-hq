// `await response.text()` buffers the whole body in memory with no ceiling.
// An RHQ base URL that is misconfigured or hostile could stream the worker
// out of memory that way. Content-Length cannot be relied on
// alone: a chunked request has none, and a lying one is only a hint. So the
// stream is read chunk by chunk and abandoned the moment it passes the cap.

/** RHQ API answers (a few KB at most) fit well inside this. */
export const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * The declared Content-Length, when it is a plain non-negative integer.
 * Anything else is treated as absent: the streamed cap still applies.
 */
export function declaredLength(headers: {
  get(name: string): string | null;
}): number | null {
  const raw = headers.get("content-length");
  if (raw === null || !/^[0-9]{1,16}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/**
 * The slice of a web ReadableStream this module uses. Structural, because
 * Node's web stream type and the DOM lib's are distinct nominal types that describe the same object.
 */
export interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel(reason?: unknown): Promise<void>;
  };
  cancel(reason?: unknown): Promise<void>;
}

/**
 * The body as UTF-8 text, or BodyTooLargeError once more than `maxBytes`
 * have arrived. Cancelling the reader tells the transport to stop receiving
 * (the socket is destroyed) instead of draining the rest to discard it.
 */
export async function readTextCapped(
  // Chunks are checked rather than typed: see ByteStream.
  body: ByteStream | null,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  // Streaming decode: a multi-byte character split across two chunks must
  // not become two replacement characters in the JSON parsed afterwards.
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => {});
      throw new TypeError("Body stream produced a non-byte chunk");
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
