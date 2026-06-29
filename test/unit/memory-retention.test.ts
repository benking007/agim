// Memory TTL retention — security hardening item ②.
//
// LRU semantics: `last_referenced_at` is what counts for pruning, not
// `created_at`. queryFacts bumps last_referenced_at for returned rows
// so frequently-recalled facts survive even after the retention window
// from their original creation.
//
// Strategy mirrors outbox.test.ts — probe DB availability via a saveFact
// call (returns null when better-sqlite3 native binding isn't loadable,
// e.g. bun runtime), and skip the DB-backed suite when degraded. In CI
// with native bindings the suite actually validates the SQL paths.

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const { AGIM_HOME } = await import('../../src/core/agim-paths.js')
const mem = await import('../../src/core/memory.js')

const MEMORY_DB = join(AGIM_HOME, 'memory.db')

// Probe DB availability. saveFact returns null when the helper is in
// fail-soft mode (no native binding).
const dbAvailable = (() => {
  try {
    const id = mem.saveFact({ user_key: 'probe-' + randomUUID(), what: 'probe' })
    return id !== null
  } catch {
    return false
  }
})()
const dbDescribe = dbAvailable ? describe : describe.skip

function openRaw(): Database.Database {
  return new Database(MEMORY_DB)
}

function uniq(): string { return 'test-ret-' + randomUUID().slice(0, 8) }

afterAll(() => {
  mem.stopMemoryRetentionSweep()
})

dbDescribe('pruneExpiredFacts', () => {
  beforeEach(() => {
    delete process.env.AGIM_MEMORY_FACT_RETENTION_DAYS
  })

  it('does nothing when retention is 0 (permanent)', () => {
    process.env.AGIM_MEMORY_FACT_RETENTION_DAYS = '0'
    const u = uniq()
    mem.saveFact({ user_key: u, what: 'ancient fact' })
    const raw = openRaw()
    try {
      raw.prepare('UPDATE facts SET last_referenced_at = 0, created_at = 0 WHERE user_key = ?').run(u)
      const before = mem.countFacts(u)
      const deleted = mem.pruneExpiredFacts()
      expect(deleted).toBe(0)
      expect(mem.countFacts(u)).toBe(before)
    } finally { raw.close() }
  })

  it('deletes facts whose last_referenced_at is older than the window', () => {
    process.env.AGIM_MEMORY_FACT_RETENTION_DAYS = '7'
    const u = uniq()
    mem.saveFact({ user_key: u, what: 'recent fact' })
    mem.saveFact({ user_key: u, what: 'stale fact' })
    const raw = openRaw()
    try {
      const staleTs = Math.floor(Date.now() / 1000) - 30 * 86400
      raw.prepare(`
        UPDATE facts SET last_referenced_at = ?
        WHERE user_key = ? AND what = 'stale fact'
      `).run(staleTs, u)

      expect(mem.countFacts(u)).toBe(2)
      mem.pruneExpiredFacts()
      const rows = raw.prepare('SELECT what FROM facts WHERE user_key = ?').all(u) as Array<{ what: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0].what).toBe('recent fact')
    } finally { raw.close() }
  })

  it('LRU semantics — facts re-referenced inside window survive past creation TTL', () => {
    process.env.AGIM_MEMORY_FACT_RETENTION_DAYS = '7'
    const u = uniq()
    const id = mem.saveFact({ user_key: u, what: 'old-but-active fact' })
    expect(id).not.toBeNull()
    const raw = openRaw()
    try {
      const now = Math.floor(Date.now() / 1000)
      raw.prepare(`
        UPDATE facts SET created_at = ?, last_referenced_at = ?
        WHERE id = ?
      `).run(now - 90 * 86400, now - 3600, id)

      mem.pruneExpiredFacts()
      const rows = raw.prepare('SELECT id FROM facts WHERE user_key = ?').all(u) as Array<{ id: number }>
      expect(rows).toHaveLength(1)
    } finally { raw.close() }
  })

  it('removes facts_fts rows in lockstep with facts (no stale index entries)', () => {
    process.env.AGIM_MEMORY_FACT_RETENTION_DAYS = '1'
    const u = uniq()
    const marker = 'ftsmarker' + randomUUID().slice(0, 6).replace(/-/g, '')
    mem.saveFact({ user_key: u, what: marker })

    const raw = openRaw()
    try {
      raw.prepare('UPDATE facts SET last_referenced_at = 0 WHERE user_key = ?').run(u)

      const ftsBefore = raw.prepare(`
        SELECT COUNT(*) AS n FROM facts_fts WHERE facts_fts MATCH ?
      `).get(`"${marker}"`) as { n: number }
      expect(ftsBefore.n).toBeGreaterThan(0)

      mem.pruneExpiredFacts()

      const ftsAfter = raw.prepare(`
        SELECT COUNT(*) AS n FROM facts_fts WHERE facts_fts MATCH ?
      `).get(`"${marker}"`) as { n: number }
      expect(ftsAfter.n).toBe(0)
    } finally { raw.close() }
  })

  it('invalid retention env var falls back to default (does not crash)', () => {
    process.env.AGIM_MEMORY_FACT_RETENTION_DAYS = 'not-a-number'
    expect(() => mem.pruneExpiredFacts()).not.toThrow()
  })
})

dbDescribe('pruneExpiredPersona', () => {
  beforeEach(() => {
    delete process.env.AGIM_PERSONA_RETENTION_DAYS
  })

  it('does nothing when retention is 0', () => {
    process.env.AGIM_PERSONA_RETENTION_DAYS = '0'
    const u = uniq()
    mem.upsertPersona(u, 'summary one')
    const raw = openRaw()
    try {
      raw.prepare('UPDATE persona_profile SET updated_at = 0 WHERE user_key = ?').run(u)
      const deleted = mem.pruneExpiredPersona()
      expect(deleted).toBe(0)
      expect(mem.getPersona(u)).not.toBeNull()
    } finally { raw.close() }
  })

  it('deletes persona rows older than retention window', () => {
    process.env.AGIM_PERSONA_RETENTION_DAYS = '30'
    const u = uniq()
    mem.upsertPersona(u, 'old summary')
    const raw = openRaw()
    try {
      const ts60 = Math.floor(Date.now() / 1000) - 60 * 86400
      raw.prepare('UPDATE persona_profile SET updated_at = ? WHERE user_key = ?').run(ts60, u)
      expect(mem.getPersona(u)).not.toBeNull()
      mem.pruneExpiredPersona()
      expect(mem.getPersona(u)).toBeNull()
    } finally { raw.close() }
  })

  it('keeps persona rows updated inside the window', () => {
    process.env.AGIM_PERSONA_RETENTION_DAYS = '30'
    const u = uniq()
    mem.upsertPersona(u, 'fresh summary')
    mem.pruneExpiredPersona()
    expect(mem.getPersona(u)).not.toBeNull()
  })
})

// Always-runnable tests — pure helpers / fail-soft paths that don't
// need the native binding.
describe('memory retention (degraded-safe)', () => {
  it('pruneExpiredFacts is a no-op when DB unavailable', () => {
    if (dbAvailable) return  // covered by dbDescribe above
    expect(mem.pruneExpiredFacts()).toBe(0)
  })

  it('pruneExpiredPersona is a no-op when DB unavailable', () => {
    if (dbAvailable) return
    expect(mem.pruneExpiredPersona()).toBe(0)
  })

  it('stopMemoryRetentionSweep is idempotent', () => {
    expect(() => {
      mem.stopMemoryRetentionSweep()
      mem.stopMemoryRetentionSweep()
    }).not.toThrow()
  })
})
