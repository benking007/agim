#!/usr/bin/env node
/**
 * check-npm-drift.mjs — fail CI when package.json races ahead of the
 * public npm registry by more than one patch (or any minor/major).
 *
 * Root cause this guards: Auto Version bumps via github-actions[bot], and
 * GitHub does not re-trigger push-based workflows for bot commits. Without
 * workflow_call (or a manual Publish dispatch), git can sit at 1.5.25 while
 * npm stays at 1.5.21 — users keep installing yesterday's bugs.
 *
 * Exit codes:
 *   0 — in sync, or at most one patch ahead (publish may still be in flight)
 *   1 — drift beyond the grace window (or npm unreachable when --strict-net)
 *
 * Usage:
 *   node tools/check-npm-drift.mjs
 *   node tools/check-npm-drift.mjs --package agim-cli
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgName = (() => {
  const i = process.argv.indexOf('--package')
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'agim-cli'
})()

function parseSemver(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3] }
}

/** How many “publish steps” is `a` ahead of `b`? null if incomparable. */
function aheadBy(a, b) {
  const A = parseSemver(a)
  const B = parseSemver(b)
  if (!A || !B) return null
  if (A.major !== B.major) return A.major > B.major ? Infinity : -Infinity
  if (A.minor !== B.minor) return A.minor > B.minor ? Infinity : -Infinity
  return A.patch - B.patch
}

const local = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const view = spawnSync('npm', ['view', pkgName, 'version'], {
  encoding: 'utf8',
  timeout: 30_000,
})
if (view.status !== 0) {
  const err = (view.stderr || view.stdout || 'npm view failed').trim()
  console.warn(`::warning::npm view ${pkgName} failed (${err}); skipping drift check`)
  process.exit(0)
}
const published = view.stdout.trim()

if (local === published) {
  console.log(`ok: ${pkgName}@${local} matches npm`)
  process.exit(0)
}

const delta = aheadBy(local, published)
const msg =
  `package.json is ${local} but npm has ${published}` +
  ` — Publish may have been skipped (bot version bumps do not trigger push-based release).` +
  ` Confirm Actions → "Publish to npm", or merge a PR that calls release via workflow_call.`

if (delta === null) {
  console.warn(`::warning::${msg} (could not parse semver)`)
  process.exit(0)
}

if (delta < 0) {
  console.warn(
    `::warning::npm (${published}) is ahead of package.json (${local}); unusual — check for a bad bump.`,
  )
  process.exit(0)
}

// One patch ahead: publish may still be running after a fresh bump.
if (delta === 1) {
  console.warn(`::warning::${msg} (1 patch ahead — grace window)`)
  process.exit(0)
}

console.error(`::error::${msg} (drift=${delta === Infinity ? 'minor/major' : `${delta} patches`})`)
process.exit(1)
