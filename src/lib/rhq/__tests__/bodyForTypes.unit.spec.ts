import type { PayloadV1 } from "../../../core/payload/types";
import type { RhqClient, RhqConnection } from "../client";

// Compile-time only: the push step hands bodyFor the core's PayloadV1, an
// interface, which has no index signature. tsc fails this file if bodyFor
// narrows its parameter.
type Accepts = Parameters<RhqClient["bodyFor"]>[0];
const _check = (p: PayloadV1, c: RhqConnection, client: RhqClient) =>
  client.bodyFor(p satisfies Accepts, c);

it("takes the core's payload type", () => {
  expect(typeof _check).toBe("function");
});
