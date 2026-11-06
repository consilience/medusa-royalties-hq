import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const script = join(__dirname, "..", "check-tarball.mjs")
const TERMS = "forbiddenword\n# end of term list\n"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-tarball-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function pack(files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, "package", path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  const tgz = join(root, "out.tgz")
  execFileSync("tar", ["-czf", tgz, "-C", root, "package"])
  return tgz
}

function check(tgz: string) {
  const env = { ...process.env, RHQ_DENY_TERMS: TERMS }
  return spawnSync(process.execPath, [script, tgz], { encoding: "utf8", env })
}

const good = {
  "package.json": "{}",
  "README.md": "# Readme\n",
  ".medusa/server/src/index.js": "export const a = 1\n",
}

describe("check-tarball", () => {
  it("passes a clean tarball", () => {
    const result = check(pack(good))
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  it("refuses a file that must not ship", () => {
    const result = check(pack({ ...good, "tests/fixtures/order.json": "{}" }))
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/tests\/fixtures\/order\.json/)
  })

  it("refuses a private term, and reports it by number", () => {
    const result = check(pack({ ...good, "README.md": "a forbiddenword here\n" }))
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/README\.md/)
    expect(result.stderr).not.toMatch(/forbiddenword/)
  })

  it("refuses a comment in compiled code", () => {
    const result = check(pack({ ...good, ".medusa/server/src/index.js": "// a note\nexport const a = 1\n" }))
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/comment/)
  })

  it("refuses a file that isn't a tarball", () => {
    const path = join(root, "bad.tgz")
    writeFileSync(path, "not a tarball")
    expect(check(path).status).toBe(1)
  })
})
