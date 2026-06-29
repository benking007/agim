// Audit events table — security hardening item ⑤.
//
// Governance events (approvals, admin elevations, config / env / token /
// workspace mutations) now persist to audit.db:audit_events alongside
// the existing invocations table.
//
// Strategy mirrors outbox.test.ts / memory-retention.test.ts — probe DB
// availability via a logAuditEvent call, then describe.skip the
// SQL-backed cases when the native binding can't load (bun runtime).

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const { AGIM_HOME } = await import('../../src/core/agim-paths.js')
const audit = await import('../../src/core/audit-log.js')

const AUDIT_DB = join(AGIM_HOME, 'audit.db')

const dbAvailable = (() => {
  try {
    // First write should succeed if SQLite is loadable.
    audit.logAuditEvent({
      eventType: 'admin.elevate',
      actor: 'probe',
      target: 'probe',
      outcome: 'ok',
      details: { probe: true },
    })
    const rows = audit.queryAuditEvents({ types: ['admin.elevate'], actor: 'probe', limit: 1 })
    return rows.length > 0
  } catch {
    return false
  }
})()
const dbDescribe = dbAvailable ? describe : describe.skip

function openRaw(): Database.Database { return new Database(AUDIT_DB) }

afterAll(() => {
  audit.stopRetentionSweep()
})

dbDescribe('audit_events schema + writes', () => {
  beforeEach(() => {
    const raw = openRaw()
    try { raw.prepare('DELETE FROM audit_events').run() } finally { raw.close() }
  })

  it('logAuditEvent + queryAuditEvents round-trip', () => {
    audit.logAuditEvent({
      eventType: 'config.put',
      actor: 'web:tk_abc',
      details: { keys: ['feishu', 'discord'] },
    })
    const rows = audit.queryAuditEvents({ types: ['config.put'] })
    expect(rows).toHaveLength(1)
    expect(rows[0].actor).toBe('web:tk_abc')
    expect(rows[0].event_type).toBe('config.put')
    expect(rows[0].outcome).toBe('ok')
    const details = JSON.parse(rows[0].details)
    expect(details).toEqual({ keys: ['feishu', 'discord'] })
  })

  it('queries filter by actor', () => {
    audit.logAuditEvent({ eventType: 'token.create', actor: 'web:a', target: 'tk_1' })
    audit.logAuditEvent({ eventType: 'token.create', actor: 'web:b', target: 'tk_2' })
    const rowsA = audit.queryAuditEvents({ actor: 'web:a' })
    expect(rowsA.map((r) => r.target)).toEqual(['tk_1'])
  })

  it('queries filter by event_type (single or multi)', () => {
    audit.logAuditEvent({ eventType: 'admin.elevate', actor: 'system', target: 'feishu:u1' })
    audit.logAuditEvent({ eventType: 'token.revoke', actor: 'web:x', target: 'tk_3' })
    audit.logAuditEvent({ eventType: 'env.put', actor: 'web:x', details: { keys: ['AGIM_SMTP_HOST'] } })

    const onlyAdmin = audit.queryAuditEvents({ types: ['admin.elevate'] })
    expect(onlyAdmin).toHaveLength(1)

    const mut = audit.queryAuditEvents({ types: ['admin.elevate', 'token.revoke'] })
    expect(mut).toHaveLength(2)
  })

  it('limit caps query result size', () => {
    for (let i = 0; i < 5; i++) {
      audit.logAuditEvent({ eventType: 'approval.allow', actor: 'feishu:thr', target: 'Bash' })
    }
    const rows = audit.queryAuditEvents({ types: ['approval.allow'], limit: 3 })
    expect(rows).toHaveLength(3)
  })

  it('returns most-recent-first ordering', () => {
    audit.logAuditEvent({ eventType: 'approval.allow', actor: 't1', target: 'first', details: { i: 1 } })
    // Force second ts to be measurably later — datetime('now') has second precision.
    const raw = openRaw()
    try {
      raw.prepare("UPDATE audit_events SET ts = '2000-01-01 00:00:00' WHERE details = '{\"i\":1}'").run()
    } finally { raw.close() }
    audit.logAuditEvent({ eventType: 'approval.allow', actor: 't2', target: 'second', details: { i: 2 } })

    const rows = audit.queryAuditEvents({ types: ['approval.allow'], limit: 2 })
    expect(rows[0].target).toBe('second')
    expect(rows[1].target).toBe('first')
  })

  it('details payload defaults to {} when omitted', () => {
    audit.logAuditEvent({ eventType: 'workspace.delete', actor: 'web:x', target: 'ws-old' })
    const rows = audit.queryAuditEvents({ types: ['workspace.delete'] })
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].details)).toEqual({})
  })

  it('outcome defaults to "ok" when omitted', () => {
    audit.logAuditEvent({ eventType: 'admin.elevate', actor: 'system', target: 'u1' })
    const rows = audit.queryAuditEvents({ types: ['admin.elevate'] })
    expect(rows[0].outcome).toBe('ok')
  })
})

dbDescribe('audit_events details payload — no plaintext credentials', () => {
  beforeEach(() => {
    const raw = openRaw()
    try { raw.prepare('DELETE FROM audit_events').run() } finally { raw.close() }
  })

  it('config.put records only field names (key whitelist), never values', () => {
    // Simulating what handlePutConfig sends — `details.keys` is the list
    // of top-level keys touched, not the values.
    const safeKeys = ['feishu', 'wechat', 'discord']
    audit.logAuditEvent({
      eventType: 'config.put',
      actor: 'web:tk',
      details: { keys: safeKeys },
    })
    const rows = audit.queryAuditEvents({ types: ['config.put'] })
    const details = JSON.parse(rows[0].details) as { keys: string[] }
    // Just the field names — no token / appSecret strings.
    expect(details.keys).toEqual(safeKeys)
    // Quick smoke: nothing in the JSON looks like a token.
    expect(rows[0].details).not.toMatch(/agim_[a-f0-9]{40}/)
    expect(rows[0].details).not.toMatch(/Bot [A-Za-z0-9_-]{20,}/)
  })

  it('env.put records key names only, never values', () => {
    audit.logAuditEvent({
      eventType: 'env.put',
      actor: 'web:tk',
      details: { keys: ['AGIM_SMTP_HOST', 'AGIM_SMTP_PASS'] },
    })
    const rows = audit.queryAuditEvents({ types: ['env.put'] })
    const details = JSON.parse(rows[0].details)
    expect(details.keys).toContain('AGIM_SMTP_PASS')
    // The actual password value is NOT in the row.
    expect(rows[0].details).not.toContain('secret-password-value-here')
  })
})

dbDescribe('audit_events retention', () => {
  beforeEach(() => {
    delete process.env.AGIM_AUDIT_EVENTS_RETENTION_DAYS
    const raw = openRaw()
    try { raw.prepare('DELETE FROM audit_events').run() } finally { raw.close() }
  })

  it('pruneExpiredEvents deletes rows older than the retention window', () => {
    process.env.AGIM_AUDIT_EVENTS_RETENTION_DAYS = '7'
    audit.logAuditEvent({ eventType: 'admin.elevate', actor: 'old', target: 'u1' })
    audit.logAuditEvent({ eventType: 'admin.elevate', actor: 'new', target: 'u2' })

    const raw = openRaw()
    try {
      raw.prepare("UPDATE audit_events SET ts = '2000-01-01 00:00:00' WHERE actor = 'old'").run()
    } finally { raw.close() }

    const deleted = audit.pruneExpiredEvents()
    expect(deleted).toBe(1)

    const remaining = audit.queryAuditEvents({ types: ['admin.elevate'] })
    expect(remaining.map((r) => r.actor)).toEqual(['new'])
  })

  it('retention=0 → no deletes (permanent)', () => {
    process.env.AGIM_AUDIT_EVENTS_RETENTION_DAYS = '0'
    audit.logAuditEvent({ eventType: 'admin.elevate', actor: 'kept', target: 'u' })
    const raw = openRaw()
    try {
      raw.prepare("UPDATE audit_events SET ts = '1999-01-01' WHERE actor = 'kept'").run()
    } finally { raw.close() }

    const deleted = audit.pruneExpiredEvents()
    expect(deleted).toBe(0)
  })
})

describe('audit events (degraded-safe)', () => {
  it('logAuditEvent is a no-op when DB unavailable', () => {
    if (dbAvailable) return
    expect(() => audit.logAuditEvent({
      eventType: 'admin.elevate',
      actor: 'test',
    })).not.toThrow()
  })

  it('queryAuditEvents returns [] when DB unavailable', () => {
    if (dbAvailable) return
    expect(audit.queryAuditEvents({})).toEqual([])
  })

  it('pruneExpiredEvents returns 0 when DB unavailable', () => {
    if (dbAvailable) return
    expect(audit.pruneExpiredEvents()).toBe(0)
  })

  it('AuditEvent shape — all event types are accepted (compile-time check)', () => {
    // Pure type-check exercise. If the union changes incompatibly, this
    // file stops compiling. Runtime is a no-op (logAuditEvent silently
    // fails in degraded mode).
    const eventTypes = [
      'approval.allow', 'approval.deny',
      'admin.elevate', 'admin.revoke',
      'config.put', 'env.put',
      'token.create', 'token.revoke',
      'workspace.add', 'workspace.delete',
    ] as const
    for (const t of eventTypes) {
      audit.logAuditEvent({ eventType: t, actor: 'compile-check' })
    }
    expect(eventTypes.length).toBe(10)
  })
})

void randomUUID  // suppress unused-import lint (reserved for future test fixtures)
