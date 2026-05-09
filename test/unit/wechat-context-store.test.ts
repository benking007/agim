// WeChat context_token persistent store — unit tests.
//
// Sets IMHUB_WECHAT_CONTEXT_DB to a temp file BEFORE importing the module,
// same pattern as reminders.test.ts. DB tests are skip-on-bun via probe.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DIR = join(tmpdir(), `imhub-wechat-ctx-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
const TEST_DB = join(TEST_DIR, 'wechat-context.db')
process.env.IMHUB_WECHAT_CONTEXT_DB = TEST_DB

const storeMod = await import('../../src/plugins/messengers/wechat/context-store.js')
const {
  persistContextToken, loadContextToken, loadAllContextTokens,
  cleanupExpiredTokens, deleteContextToken, closeContextStore,
} = storeMod

const TTL_30M = 30 * 60 * 1000

// Probe DB availability; skip if better-sqlite3 isn't loadable (bun runtime).
// persist*/delete* fail-soft (no throw), so we have to roundtrip to know.
const dbAvailable = (() => {
  try {
    const now = Date.now()
    persistContextToken('_probe_', 'tok', now)
    const got = loadContextToken('_probe_', 60_000, now)
    deleteContextToken('_probe_')
    return got !== null
  } catch {
    return false
  }
})()
const skipIfNoDb = dbAvailable ? describe : describe.skip

skipIfNoDb('wechat context-store', () => {
  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true })
  })
  afterAll(async () => {
    closeContextStore()
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('persist + load roundtrip', () => {
    const now = Date.now()
    persistContextToken('userA', 'tokA', now)
    const got = loadContextToken('userA', TTL_30M, now)
    expect(got).not.toBeNull()
    expect(got!.token).toBe('tokA')
    expect(got!.fetchedAt).toBe(now)
  })

  it('UPSERT overwrites token + timestamp', () => {
    const t1 = Date.now() - 5_000
    const t2 = Date.now()
    persistContextToken('userB', 'old', t1)
    persistContextToken('userB', 'new', t2)
    const got = loadContextToken('userB', TTL_30M, t2)
    expect(got!.token).toBe('new')
    expect(got!.fetchedAt).toBe(t2)
  })

  it('expired token returns null + is auto-pruned on read', () => {
    const tokenAge = TTL_30M + 60_000
    const fetchedAt = Date.now() - tokenAge
    persistContextToken('userC', 'stale', fetchedAt)
    const got = loadContextToken('userC', TTL_30M, Date.now())
    expect(got).toBeNull()
    // Second read also null (already pruned)
    expect(loadContextToken('userC', TTL_30M, Date.now())).toBeNull()
  })

  it('loadAll skips expired and returns valid', () => {
    const now = Date.now()
    persistContextToken('valid1', 't1', now - 5 * 60_000)
    persistContextToken('valid2', 't2', now - 1 * 60_000)
    persistContextToken('expired1', 'tx', now - 60 * 60_000)

    const all = loadAllContextTokens(TTL_30M, now)
    const ids = all.map((r) => r.userId).sort()
    expect(ids).toContain('valid1')
    expect(ids).toContain('valid2')
    expect(ids).not.toContain('expired1')
  })

  it('cleanupExpiredTokens reports deletion count', () => {
    const now = Date.now()
    persistContextToken('keep', 'tk', now - 1_000)
    persistContextToken('drop1', 'td', now - 60 * 60_000)
    persistContextToken('drop2', 'td', now - 90 * 60_000)
    const n = cleanupExpiredTokens(TTL_30M, now)
    expect(n).toBeGreaterThanOrEqual(2)
    expect(loadContextToken('keep', TTL_30M, now)).not.toBeNull()
    expect(loadContextToken('drop1', TTL_30M, now)).toBeNull()
  })

  it('deleteContextToken removes single row', () => {
    const now = Date.now()
    persistContextToken('toDelete', 'gone', now)
    expect(loadContextToken('toDelete', TTL_30M, now)).not.toBeNull()
    deleteContextToken('toDelete')
    expect(loadContextToken('toDelete', TTL_30M, now)).toBeNull()
  })
})
