// Node-only regression test for the SQLite-backed memory store.
//
// WHY node, not bun: the memory layer uses better-sqlite3 (a native addon)
// which bun cannot load (https://github.com/oven-sh/bun/issues/4290), so the
// `bun test` suite silently runs every memory query against a DISABLED db and
// can never exercise the real SQL. The `t.user_key = ?` recall bug
// (facts_fts is a contentless FTS5 table whose UNINDEXED user_key reads NULL,
// so the filter dropped every keyword hit) shipped precisely because of that
// blind spot. This script runs under node against the real store.
//
// Run after `npm run build` (imports the compiled dist). Exit 1 on any failure.
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distMemory = join(here, '..', '..', 'dist', 'core', 'memory.js')
if (!existsSync(distMemory)) {
  console.error('memory-recall: dist not built — run `npm run build` (or `npx tsc`) first.')
  process.exit(2)
}

process.env.IMHUB_MEMORY_ENABLED = '1'
const home = mkdtempSync(join(tmpdir(), 'agim-mem-node-'))
process.env.AGIM_HOME = home
process.env.IMHUB_HOME = home
delete process.env.IMHUB_MEMORY_VECTOR_BACKEND // vectors off → FTS5 fallback path

const memory = await import(distMemory)

let failures = 0
const check = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

const A = memory.userKey('tui', 'alice')
const B = memory.userKey('tui', 'bob')
memory.saveFact({ user_key: A, what: 'Alice is building agim and likes 咖啡 in 杭州', category: 'fact', confidence: 0.9, source: 'test' })
memory.saveFact({ user_key: A, what: 'Alice prefers a dark theme', category: 'preference', confidence: 0.8, source: 'test' })
memory.saveFact({ user_key: B, what: 'Bob also mentions agim', category: 'fact', confidence: 0.9, source: 'test' })

// Keyword recall — the bug returned 0 for all of these.
const ascii = memory.queryFacts({ user_key: A, query: 'agim', k: 5 })
check('ASCII keyword recall (agim)', ascii.facts.length === 1 && /agim/.test(ascii.facts[0].what))
check('CJK keyword recall (咖啡)', memory.queryFacts({ user_key: A, query: '咖啡', k: 5 }).facts.length === 1)
check('CJK keyword recall (杭州)', memory.queryFacts({ user_key: A, query: '杭州', k: 5 }).facts.length === 1)

// Per-user isolation must survive the f.user_key scoping.
check('isolation: alice query returns only alice facts', ascii.facts.every((f) => f.user_key === A))
const bobQ = memory.queryFacts({ user_key: B, query: 'agim', k: 5 })
check('isolation: bob recalls only his own agim fact', bobQ.facts.length === 1 && bobQ.facts[0].user_key === B)

// Hybrid (vector off → FTS fallback) must recall too.
const hybrid = await memory.queryFactsHybrid({ user_key: A, query: 'agim', k: 5 })
check('hybrid recall falls back to FTS and hits', hybrid.facts.length === 1)

// listFacts keyword search (Web Memory tab path) must also match.
const listed = memory.listFacts({ user_key: A, query: 'agim', limit: 10, offset: 0 })
check('listFacts keyword search returns the hit', listed.total === 1 && listed.facts.length === 1)

// Recency (no query) — the path that already worked.
check('recency list (no query) returns all', memory.queryFacts({ user_key: A, k: 10 }).facts.length === 2)

try { memory.closeMemoryDb?.() } catch { /* ignore */ }
try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }

if (failures > 0) {
  console.error(`\nmemory-recall: FAILED (${failures} check(s))`)
  process.exit(1)
}
console.log('\nmemory-recall: all checks passed.')
