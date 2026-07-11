// Memory write-time dedup (v1.6) — distillation must not re-insert a fact
// it already learned. Covers findFactIdByWhat (exact, case/space-insensitive,
// user-scoped) + touchFact (reinforcement bump of last_referenced_at).
//
// Mirrors memory-retention.test.ts: probe DB availability via saveFact and
// skip the DB-backed suite when the native binding isn't loadable (bun).
// In CI with native bindings (node) the suite validates the real SQL paths.

import { describe, it, expect, afterAll } from 'bun:test'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const { AGIM_HOME } = await import('../../src/core/agim-paths.js')
const mem = await import('../../src/core/memory.js')

const MEMORY_DB = join(AGIM_HOME, 'memory.db')

const dbAvailable = (() => {
  try {
    const id = mem.saveFact({ user_key: `probe-${randomUUID()}`, what: 'probe' })
    return id !== null
  } catch {
    return false
  }
})()
const dbDescribe = dbAvailable ? describe : describe.skip

function uniq(): string { return `test-dedup-${randomUUID().slice(0, 8)}` }

afterAll(() => {
  try { mem.stopMemoryRetentionSweep() } catch { /* ignore */ }
})

dbDescribe('findFactIdByWhat', () => {
  it('finds an existing fact by exact what (case + surrounding space insensitive), scoped to user', () => {
    const u = uniq()
    const id = mem.saveFact({ user_key: u, what: '我住在杭州' })
    expect(id).not.toBeNull()
    expect(mem.findFactIdByWhat(u, '我住在杭州')).toBe(id)
    expect(mem.findFactIdByWhat(u, '  我住在杭州  ')).toBe(id) // surrounding space
    expect(mem.findFactIdByWhat(u, 'USER likes TEA')).toBeNull() // different content
    // Not visible to a different user partition.
    expect(mem.findFactIdByWhat(uniq(), '我住在杭州')).toBeNull()
  })

  it('returns null for unknown / empty what', () => {
    const u = uniq()
    expect(mem.findFactIdByWhat(u, 'never saved')).toBeNull()
    expect(mem.findFactIdByWhat(u, '')).toBeNull()
    expect(mem.findFactIdByWhat(u, '   ')).toBeNull()
  })

  it('case-insensitive match for ASCII content', () => {
    const u = uniq()
    const id = mem.saveFact({ user_key: u, what: 'User prefers Tabs over spaces' })
    expect(mem.findFactIdByWhat(u, 'user prefers tabs over spaces')).toBe(id)
  })
})

dbDescribe('touchFact — reinforcement bump', () => {
  it('advances last_referenced_at without inserting a row', () => {
    const u = uniq()
    const id = mem.saveFact({ user_key: u, what: 'reinforce me' })!
    const raw = new Database(MEMORY_DB)
    try {
      const before = raw.prepare('SELECT last_referenced_at FROM facts WHERE id = ?').get(id) as { last_referenced_at: number }
      const countBefore = raw.prepare('SELECT COUNT(*) AS n FROM facts WHERE user_key = ?').get(u) as { n: number }
      // Force an older timestamp so the bump is observable within the same second.
      raw.prepare('UPDATE facts SET last_referenced_at = ? WHERE id = ?').run(before.last_referenced_at - 1000, id)
      mem.touchFact(id)
      const after = raw.prepare('SELECT last_referenced_at FROM facts WHERE id = ?').get(id) as { last_referenced_at: number }
      const countAfter = raw.prepare('SELECT COUNT(*) AS n FROM facts WHERE user_key = ?').get(u) as { n: number }
      expect(after.last_referenced_at).toBeGreaterThan(before.last_referenced_at - 1000)
      expect(countAfter.n).toBe(countBefore.n) // no new row
    } finally {
      raw.close()
    }
  })
})
