#!/usr/bin/env node
// Checks the tarball itself, the last step before it goes to npm: its file
// list, every file's text and the comments in compiled code. check:package
// reads the build, which is not always what was packed.
//
// Usage: node scripts/check-tarball.mjs <file.tgz>
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { commentsIn, internalReferences, isCheckedForComments, isText, packedPathProblem } from "./check-package.mjs"
import { denyTermsOrExit, termsIn } from "./deny-terms.mjs"

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function problemsIn(root, terms) {
  const problems = []
  for (const full of walk(root)) {
    const path = relative(root, full)
    const problem = packedPathProblem(path)
    if (problem) problems.push(problem)
    for (const hit of termsIn(path, terms, path)) problems.push(`internal reference in a file name: ${path}: ${hit}`)
    const buffer = readFileSync(full)
    if (!isText(buffer)) continue
    const text = buffer.toString("utf8")
    for (const hit of internalReferences(text, terms, path)) problems.push(`internal reference at ${path}:${hit}`)
    if (isCheckedForComments(path)) {
      for (const comment of commentsIn(text, path)) problems.push(`comment in compiled code: ${path}:${comment.line}`)
    }
  }
  return problems
}

function main() {
  const tgz = process.argv[2]
  if (!tgz) {
    console.error("usage: check-tarball.mjs <file.tgz>")
    process.exit(2)
  }
  const { terms, source } = denyTermsOrExit(process.cwd(), "tarball check")
  const dir = mkdtempSync(join(tmpdir(), "check-tarball-"))
  try {
    try {
      execFileSync("tar", ["-xzf", tgz, "-C", dir], { stdio: "pipe" })
    } catch {
      console.error(`tarball check failed: can't unpack ${tgz}`)
      process.exit(1)
    }
    const problems = problemsIn(join(dir, "package"), terms)
    if (problems.length > 0) {
      console.error(`tarball check failed (${problems.length}):`)
      for (const problem of problems) console.error(`  - ${problem}`)
      process.exitCode = 1
      return
    }
    console.log(`tarball ok: ${tgz} (private terms from ${source})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
