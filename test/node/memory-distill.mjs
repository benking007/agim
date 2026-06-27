// Node-only regression for dream distillation (the SQLite buffer + the
// background distiller). bun can't load better-sqlite3, so this must run under
// node against the built dist (see test/node/memory-recall.mjs for context).
//
// Run after `npm run build`. Exit 1 on any failed check.
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = (p) => join(here, '..', '..', 'dist', 'core', p)
if (!existsSync(dist('memory-distiller.js'))) {
  console.error('memory-distill: dist not built — run `npm run build` (or `npx tsc`) first.')
  process.exit(2)
}

process.env.IMHUB_MEMORY_ENABLED = '1'
process.env.IMHUB_MEMORY_DISTILL_SOURCE = 'auto' // zero-config: use the turn's agent
const home = mkdtempSync(join(tmpdir(), 'agim-mem-distill-'))
process.env.AGIM_HOME = home
process.env.IMHUB_HOME = home
delete process.env.IMHUB_MEMORY_VECTOR_BACKEND

const memory = await import(dist('memory.js'))
const { registry } = await import(dist('registry.js'))
const { runDistillerOnce } = await import(dist('memory-distiller.js'))

let failures = 0
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) failures++ }

// Stub agent standing in for the extraction LLM.
const prompts = []
const FACTS = { facts: [
  { what: 'Alice 住在杭州', category: 'profile', confidence: 0.9, who: 'user' },
  { what: 'Alice 在做一个叫 agim 的项目', category: 'goal', confidence: 0.85 },
] }
registry.registerAgent({
  name: 'stub-distiller',
  aliases: [],
  async *sendPrompt(_sid, prompt) { prompts.push(prompt); yield JSON.stringify(FACTS) },
})

const A = memory.userKey('tui', 'alice')
const B = memory.userKey('tui', 'bob')

// 1) Buffer mechanics (hot path).
for (let i = 0; i < 3; i++) {
  memory.enqueuePendingTurn({ user_key: A, platform: 'tui', user_message: `msg ${i} 我住杭州在做 agim`, agent_reply: `reply ${i}`, agent_name: 'stub-distiller' })
}
memory.enqueuePendingTurn({ user_key: B, platform: 'tui', user_message: 'bob 的消息', agent_reply: 'r', agent_name: 'stub-distiller' })
check('enqueue buffers turns', memory.countPendingTotal() === 4)
check('listPendingForUser returns A\'s 3 (oldest-first)', memory.listPendingForUser(A, 10).length === 3)

// 2) Staleness-floor filtering: just-enqueued rows are NOT stale.
check('floor: fresh turns excluded by olderThanSec', memory.listPendingUserKeys({ olderThanSec: 99999 }).length === 0)
check('floor: no-filter lists both users', memory.listPendingUserKeys().sort().join(',') === [A, B].sort().join(','))

// 3) Distiller pass (idle, no active jobs → processes everyone).
const processed = await runDistillerOnce()
check('runDistillerOnce processed both users', processed === 2)
check('pending cleared after processing', memory.countPendingTotal() === 0)
check('batch prompt carried multiple turns', prompts.some((p) => /第 1 轮[\s\S]*第 3 轮/.test(p)))

// 4) Extracted facts are saved + recallable + user-scoped.
const recall = memory.queryFacts({ user_key: A, query: 'agim', k: 5 })
check('extracted fact saved + recallable (agim)', recall.facts.length === 1)
check('CJK fact recallable (杭州)', memory.queryFacts({ user_key: A, query: '杭州', k: 5 }).facts.length === 1)
check('facts scoped to A (not B)', memory.queryFacts({ user_key: A, k: 10 }).facts.every((f) => f.user_key === A))

// 5) source=llm with no `distill` backend → ok:false → buffer kept (retry).
process.env.IMHUB_MEMORY_DISTILL_SOURCE = 'llm'
memory.enqueuePendingTurn({ user_key: A, platform: 'tui', user_message: '又一条 我喜欢深色主题', agent_reply: 'r', agent_name: 'stub-distiller' })
const processed2 = await runDistillerOnce()
check('source=llm with no backend processes 0 users', processed2 === 0)
check('buffer kept when no usable LLM (retry next pass)', memory.countPendingTotal() === 1)

try { memory.closeMemoryDb?.() } catch { /* ignore */ }
try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }

if (failures > 0) { console.error(`\nmemory-distill: FAILED (${failures} check(s))`); process.exit(1) }
console.log('\nmemory-distill: all checks passed.')
