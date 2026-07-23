#!/usr/bin/env node
/**
 * Line-count budgets to prevent god-file regression after the arch split.
 *
 * - Soft warn: any src file over SOFT_LIMIT (informational; exit 0).
 * - Cap fail: named composition roots must stay under agreed ceilings (exit 1).
 *
 * Pre-existing large modules outside CAPS are warned but not blocked —
 * peel them in follow-ups; do not raise CAPS to hide growth.
 *
 * Usage: node tools/check-file-budget.mjs
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOFT_LIMIT = 800

/** Composition roots / facades — must not grow past these ceilings. */
const CAPS = {
  'src/web/server.ts': 1100,
  'src/cli.ts': 700,
  'src/core/approval-bus.ts': 1200,
  'src/core/llm/agent-loop.ts': 80,
  'src/web-app/src/hooks/use-chat.ts': 400,
  'src/web-app/src/components/m-portal/agent-portal.tsx': 1000,
  'src/cli/start-runtime.ts': 900,
  'src/core/llm/agent-loop-run.ts': 850,
  'src/web/ws-chat.ts': 750,
}

const SKIP_DIR = new Set([
  'node_modules', 'dist', '.git', 'coverage', 'public', 'assets', 'fonts',
  'builtin',
])

const SKIP_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|mjs)$|\/__tests__\//

async function walk(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (SKIP_DIR.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else if (/\.(?:ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

async function lineCount(path) {
  const text = await readFile(path, 'utf8')
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

const files = (await walk(join(root, 'src')))
  .filter((p) => !SKIP_FILE.test(relative(root, p)))

const soft = []
const capBreaches = []

for (const abs of files) {
  const rel = relative(root, abs).replaceAll('\\', '/')
  const lines = await lineCount(abs)
  if (CAPS[rel] !== undefined) {
    if (lines > CAPS[rel]) capBreaches.push({ rel, lines, cap: CAPS[rel] })
    continue
  }
  if (lines > SOFT_LIMIT) soft.push({ rel, lines })
}

console.log(`[file-budget] soft=${SOFT_LIMIT} capped=${Object.keys(CAPS).length} files=${files.length}`)

if (soft.length) {
  console.log(`[file-budget] soft warnings (${soft.length}) — peel when touching these:`)
  for (const s of soft.sort((a, b) => b.lines - a.lines).slice(0, 30)) {
    console.log(`  WARN  ${s.lines}\t${s.rel}`)
  }
}

console.log('[file-budget] composition-root caps:')
for (const [rel, cap] of Object.entries(CAPS)) {
  try {
    const n = await lineCount(join(root, rel))
    const mark = n > cap ? 'FAIL' : 'ok  '
    console.log(`  ${mark}  ${n}/${cap}\t${rel}`)
  } catch {
    console.log(`  miss  -/${cap}\t${rel}`)
  }
}

if (capBreaches.length) {
  console.error(`[file-budget] CAP BREACH (${capBreaches.length})`)
  process.exit(1)
}

console.log('[file-budget] ok')
process.exit(0)
