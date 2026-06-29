// reminder-rpc.ts — RPC handler unit tests.
//
// DB tests are skip-on-bun via the same probe pattern as reminders.test.ts.
// Pure-validation tests run regardless.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunContext } from '../../src/core/approval-bus.js'

const TEST_DIR = join(tmpdir(), `agim-rpc-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
process.env.AGIM_REMINDERS_DB = join(TEST_DIR, 'reminders.db')

const rpcMod = await import('../../src/core/reminder-rpc.js')
const remindersMod = await import('../../src/core/reminders.js')
const { handleReminderOp, setReminderConfirmNotifier } = rpcMod
const { closeReminderDb, createReminder, cancelReminder } = remindersMod

const CTX: RunContext = {
  threadId: 'thread-rpc',
  platform: 'rpc-test',
  channelId: 'c',
  userId: 'rpc-user',
}

describe('reminder-rpc — payload validation', () => {
  it('create rejects missing fireAt', async () => {
    const r = await handleReminderOp('create', { text: 'x' }, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('fireAt')
  })

  it('create rejects missing text', async () => {
    const r = await handleReminderOp('create', { fireAt: '2099-01-01T00:00:00' }, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('text')
  })

  it('create rejects bad fireAt', async () => {
    const r = await handleReminderOp('create', { fireAt: 'not-a-date', text: 'x' }, CTX)
    expect(r.ok).toBe(false)
  })

  it('create rejects bad recurrence', async () => {
    const r = await handleReminderOp('create', {
      fireAt: '2099-01-01T00:00:00', text: 'x', recurrence: 'every:30s',
    }, CTX)
    expect(r.ok).toBe(false)
  })

  it('cancel rejects bad id', async () => {
    const r = await handleReminderOp('cancel', { id: 'foo' }, CTX)
    expect(r.ok).toBe(false)
  })

  it('snooze rejects bad duration', async () => {
    const r = await handleReminderOp('snooze', { id: 1, duration: 'not-a-duration' }, CTX)
    expect(r.ok).toBe(false)
  })

  it('unknown op returns error', async () => {
    const r = await handleReminderOp('frobnicate', {}, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('unknown op')
  })
})

// Probe-based DB skip (better-sqlite3 not available under bun)
const dbAvailable = (() => {
  try {
    const id = createReminder({
      fireAt: new Date(Date.now() + 60_000),
      text: 'probe', platform: 'p', channelId: 'c', threadId: 't',
      userId: '_probe_rpc_',
    })
    cancelReminder(id)
    return true
  } catch {
    return false
  }
})()
const skipIfNoDb = dbAvailable ? describe : describe.skip

skipIfNoDb('reminder-rpc — DB-backed paths', () => {
  beforeAll(async () => { await mkdir(TEST_DIR, { recursive: true }) })
  afterAll(async () => {
    closeReminderDb()
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('create + list + cancel happy path', async () => {
    // Create
    const fireAt = new Date(Date.now() + 60_000).toISOString().replace(/\..+Z$/, '')
    const created = await handleReminderOp('create', { fireAt, text: 'rpc test' }, CTX)
    expect(created.ok).toBe(true)
    const id = created.ok && (created.result as { id: number }).id
    expect(typeof id).toBe('number')

    // List
    const listed = await handleReminderOp('list', {}, CTX)
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      const items = (listed.result as { reminders: Array<{ id: number; text: string }> }).reminders
      expect(items.some((r) => r.id === id)).toBe(true)
    }

    // Cancel
    const cancelled = await handleReminderOp('cancel', { id }, CTX)
    expect(cancelled.ok).toBe(true)
  })

  it('cancel returns error when not owned', async () => {
    const otherCtx: RunContext = { ...CTX, userId: 'other-user' }
    const fireAt = new Date(Date.now() + 60_000).toISOString().replace(/\..+Z$/, '')
    const created = await handleReminderOp('create', { fireAt, text: 'owned' }, CTX)
    expect(created.ok).toBe(true)
    const id = created.ok && (created.result as { id: number }).id

    const r = await handleReminderOp('cancel', { id }, otherCtx)
    expect(r.ok).toBe(false)
  })

  it('high-freq + llm triggers pending_confirmation + notifier', async () => {
    let captured: { ctx: RunContext; message: string } | null = null
    setReminderConfirmNotifier(async (ctx, message) => { captured = { ctx, message } })

    const fireAt = new Date(Date.now() + 60_000).toISOString().replace(/\..+Z$/, '')
    const r = await handleReminderOp('create', {
      fireAt, text: '看屏幕外', recurrence: 'every:5m', // promptMode default 'llm'
    }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const result = r.result as { status: string }
      expect(result.status).toBe('pending_confirmation')
    }
    expect(captured).not.toBeNull()
    expect(captured!.message).toContain('高频循环')
    setReminderConfirmNotifier(null)
  })

  it('high-freq + literal goes through directly (no confirmation)', async () => {
    const fireAt = new Date(Date.now() + 60_000).toISOString().replace(/\..+Z$/, '')
    const r = await handleReminderOp('create', {
      fireAt, text: '看屏幕外', recurrence: 'every:5m', promptMode: 'literal',
    }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const result = r.result as { id: number }
      expect(typeof result.id).toBe('number')
    }
  })
})
