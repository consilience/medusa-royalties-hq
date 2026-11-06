// A stand-in Royalties HQ on 127.0.0.1, so the plugin's real transport is
// exercised end to end. Requests are recorded with the token reduced to
// whether it matched, so no test output can carry it.
import http from "node:http"
import { gunzipSync } from "node:zlib"
import type { AddressInfo } from "node:net"

export type Seen = { method: string; path: string; authorised: boolean; body: string }
export type Handler = (req: { method: string; path: string; body: string }) => { status: number; body: unknown; headers?: Record<string, string> }

export async function startRhq(token: string, handler: Handler) {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks)
      // The plugin gzips a snapshot when RHQ says it accepts that.
      const body = (req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8")
      const authorised = req.headers.authorization === `Bearer ${token}`
      seen.push({ method: req.method ?? "", path: req.url ?? "", authorised, body })
      const reply = authorised
        ? handler({ method: req.method ?? "", path: req.url ?? "", body })
        : { status: 401, body: { type: "urn:royaltieshq:problem:unauthenticated", title: "Unauthenticated", status: 401, detail: "Unauthenticated.", code: "unauthenticated" }, headers: { "content-type": "application/problem+json" } }
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}/api/v1`, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}
