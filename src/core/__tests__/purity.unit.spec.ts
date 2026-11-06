import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { impurities } from "../../../scripts/core-purity"

const CORE = join(__dirname, "..")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.ts$/.test(name) ? [path] : []
  })
}

describe("core purity checker", () => {
  it("flags a Medusa import", () => {
    expect(
      impurities("a.ts", `import { MedusaError } from "@medusajs/framework/utils"\n`),
    ).toEqual([{ file: "a.ts", line: 1, reason: "imports @medusajs/framework/utils" }])
  })

  it("flags node built-ins other than node:crypto, and require()", () => {
    expect(
      impurities("b.ts", `import { readFileSync } from "node:fs"\nconst x = require("pg")\nimport { createHash } from "node:crypto"\n`),
    ).toEqual([
      { file: "b.ts", line: 1, reason: "imports node:fs" },
      { file: "b.ts", line: 2, reason: "requires pg" },
    ])
  })

  it("flags float arithmetic on money: Number(), parseFloat, toFixed, Math.round", () => {
    const found = impurities(
      "c.ts",
      `const a = Number(s)\nconst b = parseFloat(s)\nconst c = n.toFixed(2)\nconst d = Math.round(n)\nconst e = Number.isInteger(n)\n`,
    )
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4])
  })

  it("allows relative imports and type-only imports of the core", () => {
    expect(impurities("d.ts", `import type { Minor } from "../money"\nimport { x } from "./x"\n`)).toEqual([])
  })
})

describe("src/core", () => {
  it("has no platform imports and no float money arithmetic", () => {
    const found = sourceFiles(CORE)
      .filter((path) => !path.includes("__tests__"))
      .flatMap((path) => impurities(relative(CORE, path), readFileSync(path, "utf8")))
    expect(found).toEqual([])
  })
})
