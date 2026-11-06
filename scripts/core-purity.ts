// Keeps src/core a pure library: its tests run without a store,
// and money stays in bigint minor units. A Medusa
// import would tie the row builder to a running store; a float would round
// money silently. node:crypto is allowed for content hashing.

export interface Impurity {
  file: string
  line: number
  reason: string
}

const ALLOWED_NODE = new Set(["node:crypto"])

const RULES: { pattern: RegExp; reason: (m: RegExpMatchArray) => string | null }[] = [
  {
    pattern: /^\s*import\s+(?!type\b)[^"']*?from\s+["']([^"']+)["']/,
    reason: (m) => moduleReason("imports", m[1]),
  },
  {
    pattern: /^\s*import\s+["']([^"']+)["']/,
    reason: (m) => moduleReason("imports", m[1]),
  },
  {
    pattern: /\brequire\(\s*["']([^"']+)["']\s*\)/,
    reason: (m) => moduleReason("requires", m[1]),
  },
  { pattern: /(?<![.\w])Number\(/, reason: () => "calls Number() (float money)" },
  { pattern: /\bparseFloat\(/, reason: () => "calls parseFloat (float money)" },
  { pattern: /\.toFixed\(/, reason: () => "calls toFixed (float money)" },
  { pattern: /\bMath\.round\(/, reason: () => "calls Math.round (float money)" },
]

function moduleReason(verb: string, spec: string): string | null {
  if (spec.startsWith(".")) return null
  if (ALLOWED_NODE.has(spec)) return null
  return `${verb} ${spec}`
}

export function impurities(file: string, source: string): Impurity[] {
  const found: Impurity[] = []
  source.split("\n").forEach((text, index) => {
    for (const rule of RULES) {
      const match = text.match(rule.pattern)
      if (!match) continue
      const reason = rule.reason(match)
      if (reason) {
        found.push({ file, line: index + 1, reason })
        break
      }
    }
  })
  return found
}
