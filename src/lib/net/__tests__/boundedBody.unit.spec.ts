
import {
  BodyTooLargeError,
  readTextCapped,
} from "../boundedBody";

function streamOf(chunks: Uint8Array[]) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[pulled++];
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
}

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);

describe("readTextCapped", () => {
  it("reads a body up to the cap as UTF-8", async () => {
    const encoded = new TextEncoder().encode('{"name":"Poppy’s Promise"}');
    // Split mid-character: the decoder must carry the partial sequence.
    const { stream } = streamOf([encoded.slice(0, 20), encoded.slice(20)]);
    await expect(readTextCapped(stream, encoded.length)).resolves.toBe(
      '{"name":"Poppy’s Promise"}',
    );
  });

  it("stops reading, cancels the stream and throws once past the cap", async () => {
    const source = streamOf([bytes(600), bytes(600), bytes(600), bytes(600)]);
    await expect(readTextCapped(source.stream, 1000)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    // Aborted at the chunk that crossed the cap, not after draining it all.
    expect(source.pulled()).toBeLessThanOrEqual(3);
    expect(source.cancelled()).toBe(true);
  });

  it("treats a missing body as empty", async () => {
    await expect(readTextCapped(null, 10)).resolves.toBe("");
  });
});
