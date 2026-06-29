// Viewer paste TTL — security hardening item ②.
//
// Time-based retention runs ON TOP of the existing LRU capacity evict.
// Probes DB availability via savePaste (returns null in fail-soft mode)
// and skips DB-backed cases under bun.

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import Database from 'better-sqlite3'
import { join } from 'node:path'

const { AGIM_HOME } = await import('../../src/core/agim-paths.js')
const viewer = await import('../../src/core/viewer-local.js')

const VIEWER_DB = join(AGIM_HOME, 'viewer.db')

const dbAvailable = (() => {
  try {
    const id = viewer.savePaste({ content: 'probe' })
    return id !== null
  } catch {
    return false
  }
})()
const dbDescribe = dbAvailable ? describe : describe.skip

function openRaw(): Database.Database { return new Database(VIEWER_DB) }

afterAll(() => {
  viewer.stopViewerRetentionSweep()
})

dbDescribe('pruneExpiredPastes', () => {
  beforeEach(() => {
    delete process.env.AGIM_PASTE_RETENTION_DAYS
    const raw = openRaw()
    try { raw.prepare('DELETE FROM pastes').run() } finally { raw.close() }
  })

  it('does nothing when retention is 0 (permanent)', () => {
    process.env.AGIM_PASTE_RETENTION_DAYS = '0'
    const id = viewer.savePaste({ content: 'ancient paste' })
    expect(id).not.toBeNull()
    const raw = openRaw()
    try {
      raw.prepare('UPDATE pastes SET created_at = 0 WHERE id = ?').run(id)
      const deleted = viewer.pruneExpiredPastes()
      expect(deleted).toBe(0)
      expect(viewer.getPaste(id!)).not.toBeNull()
    } finally { raw.close() }
  })

  it('deletes pastes older than the window', () => {
    process.env.AGIM_PASTE_RETENTION_DAYS = '7'
    const recent = viewer.savePaste({ content: 'recent' })
    const stale = viewer.savePaste({ content: 'stale' })
    expect(recent).not.toBeNull()
    expect(stale).not.toBeNull()

    const raw = openRaw()
    try {
      const staleTs = Math.floor(Date.now() / 1000) - 30 * 86400
      raw.prepare('UPDATE pastes SET created_at = ? WHERE id = ?').run(staleTs, stale)

      const deleted = viewer.pruneExpiredPastes()
      expect(deleted).toBe(1)
      expect(viewer.getPaste(recent!)).not.toBeNull()
      expect(viewer.getPaste(stale!)).toBeNull()
    } finally { raw.close() }
  })

  it('keeps fresh pastes', () => {
    process.env.AGIM_PASTE_RETENTION_DAYS = '30'
    const id = viewer.savePaste({ content: 'fresh paste' })
    expect(id).not.toBeNull()
    expect(viewer.pruneExpiredPastes()).toBe(0)
    expect(viewer.getPaste(id!)).not.toBeNull()
  })

  it('invalid env value falls back to default 30d (does not crash)', () => {
    process.env.AGIM_PASTE_RETENTION_DAYS = 'garbage'
    expect(() => viewer.pruneExpiredPastes()).not.toThrow()
  })
})

describe('viewer retention (degraded-safe)', () => {
  it('pruneExpiredPastes is a no-op when DB unavailable', () => {
    if (dbAvailable) return
    expect(viewer.pruneExpiredPastes()).toBe(0)
  })

  it('stopViewerRetentionSweep is idempotent', () => {
    expect(() => {
      viewer.stopViewerRetentionSweep()
      viewer.stopViewerRetentionSweep()
    }).not.toThrow()
  })
})
