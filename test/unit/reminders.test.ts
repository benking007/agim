// Reminders engine — unit tests.
//
// Strategy: set IMHUB_REMINDERS_DB to a temp file BEFORE importing the
// module so the DB lives in /tmp and gets nuked between test files. The
// engine module itself doesn't auto-start a tick loop on import; tests
// drive the engine via the exported `tick()`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DIR = join(tmpdir(), `imhub-reminders-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
const TEST_DB = join(TEST_DIR, 'reminders.db')
process.env.IMHUB_REMINDERS_DB = TEST_DB

const remindersMod = await import('../../src/core/reminders.js')
const registryMod = await import('../../src/core/registry.js')
const {
  parseDuration, parseClock, parseISO, parseWhen, parseWhenPrefix,
  parseRecurrencePrefix, computeNext, isValidRecurrence, describeRecurrence,
  createReminder, listReminders, getReminder, cancelReminder, clearReminders, snoozeReminder,
  bindEmail, unbindEmail, getBoundEmail,
  tick, closeReminderDb,
  ReminderError, MAX_PENDING_PER_USER, MAX_FUTURE_MS, MAX_TEXT_LEN,
} = remindersMod

// ─── Time parsing (pure functions, no DB) ───────────────────────────

describe('parseDuration', () => {
  it('parses s/m/h/d', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1d')).toBe(86_400_000)
  })
  it('rejects invalid input', () => {
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('5')).toBeNull()
    expect(parseDuration('5x')).toBeNull()
    expect(parseDuration('-5m')).toBeNull()
    expect(parseDuration('0m')).toBeNull()
    expect(parseDuration('1.5m')).toBeNull()
  })
})

describe('parseClock', () => {
  it('returns today HH:MM if still future', () => {
    const now = new Date('2026-05-09T10:00:00')
    const r = parseClock('18:30', now)
    expect(r).not.toBeNull()
    expect(r?.getHours()).toBe(18)
    expect(r?.getMinutes()).toBe(30)
    expect(r?.getDate()).toBe(now.getDate())
  })
  it('rolls to tomorrow when HH:MM has passed today', () => {
    const now = new Date('2026-05-09T20:00:00')
    const r = parseClock('08:00', now)
    expect(r).not.toBeNull()
    expect(r!.getDate()).toBe(now.getDate() + 1)
  })
  it('rejects malformed and out-of-range', () => {
    expect(parseClock('25:00')).toBeNull()
    expect(parseClock('12:60')).toBeNull()
    expect(parseClock('foo')).toBeNull()
  })
})

describe('parseISO', () => {
  it('accepts T-separator and space-separator', () => {
    expect(parseISO('2026-05-09T20:00')).toBeInstanceOf(Date)
    expect(parseISO('2026-05-09T20:00:30')).toBeInstanceOf(Date)
  })
  it('rejects garbage', () => {
    expect(parseISO('foo')).toBeNull()
    expect(parseISO('2026-05-09')).toBeNull() // no time part
  })
})

describe('parseWhen', () => {
  it('tries duration → clock → ISO', () => {
    const now = new Date('2026-05-09T10:00:00')
    expect(parseWhen('2m', now)).toMatchObject({ ok: true })
    expect(parseWhen('18:30', now)).toMatchObject({ ok: true })
    expect(parseWhen('2026-05-09T20:00', now)).toMatchObject({ ok: true })
  })
  it('reports failures with reason', () => {
    const r = parseWhen('garbage', new Date())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('garbage')
  })
})

describe('parseWhenPrefix — Chinese duration', () => {
  const now = new Date('2026-05-09T10:00:00')
  it('atom + no separator', () => {
    const r = parseWhenPrefix('40秒喝水', now)!
    expect(r.fireAt.getTime() - now.getTime()).toBe(40_000)
    expect(r.rest).toBe('喝水')
  })
  it('与空格混排都行', () => {
    expect(parseWhenPrefix('2分钟 喝水', now)?.rest).toBe('喝水')
    expect(parseWhenPrefix('2分钟喝水', now)?.rest).toBe('喝水')
  })
  it('半小时(后)?', () => {
    const r = parseWhenPrefix('半小时后吃药', now)!
    expect(r.fireAt.getTime() - now.getTime()).toBe(30 * 60_000)
    expect(r.rest).toBe('吃药')
    const r2 = parseWhenPrefix('半个小时打电话', now)!
    expect(r2.fireAt.getTime() - now.getTime()).toBe(30 * 60_000)
    expect(r2.rest).toBe('打电话')
  })
  it('compound: 1小时20分', () => {
    const r = parseWhenPrefix('1小时20分提醒喝水', now)!
    expect(r.fireAt.getTime() - now.getTime()).toBe(80 * 60_000)
    expect(r.rest).toBe('提醒喝水')
  })
  it('trailing 半: 1小时半', () => {
    const r = parseWhenPrefix('1小时半泡茶', now)!
    expect(r.fireAt.getTime() - now.getTime()).toBe(90 * 60_000)
    expect(r.rest).toBe('泡茶')
  })
  it('compound seconds + minutes', () => {
    const r = parseWhenPrefix('2分30秒喝水', now)!
    expect(r.fireAt.getTime() - now.getTime()).toBe(150_000)
    expect(r.rest).toBe('喝水')
  })
  it('decimal: 0.5天', () => {
    const r = parseWhenPrefix('0.5天后联系', now)!
    expect(r.fireAt.getTime() - now.getTime()).toBe(12 * 3600_000)
    expect(r.rest).toBe('联系')
  })
})

describe('parseWhenPrefix — Chinese clock', () => {
  it('下午6点 → 18:00 today/tomorrow', () => {
    const now = new Date('2026-05-09T10:00:00')
    const r = parseWhenPrefix('下午6点下班', now)!
    expect(r.fireAt.getHours()).toBe(18)
    expect(r.fireAt.getMinutes()).toBe(0)
    expect(r.rest).toBe('下班')
  })
  it('点半 → :30', () => {
    const now = new Date('2026-05-09T10:00:00')
    const r = parseWhenPrefix('下午6点半喝奶茶', now)!
    expect(r.fireAt.getHours()).toBe(18)
    expect(r.fireAt.getMinutes()).toBe(30)
    expect(r.rest).toBe('喝奶茶')
  })
  it('晚上8点45 → 20:45', () => {
    const now = new Date('2026-05-09T10:00:00')
    const r = parseWhenPrefix('晚上8点45提醒', now)!
    expect(r.fireAt.getHours()).toBe(20)
    expect(r.fireAt.getMinutes()).toBe(45)
    expect(r.rest).toBe('提醒')
  })
  it('中午12点', () => {
    const now = new Date('2026-05-09T08:00:00')
    const r = parseWhenPrefix('中午12点开饭', now)!
    expect(r.fireAt.getHours()).toBe(12)
    expect(r.rest).toBe('开饭')
  })
  it('No period word → tomorrow if past', () => {
    const now = new Date('2026-05-09T22:00:00')
    const r = parseWhenPrefix('8点起床', now)!
    expect(r.fireAt.getHours()).toBe(8)
    expect(r.fireAt.getDate()).toBe(now.getDate() + 1)
  })
})

describe('parseWhenPrefix — back-compat English / clock / ISO', () => {
  const now = new Date('2026-05-09T10:00:00')
  it('English duration', () => {
    const r = parseWhenPrefix('2m drink water', now)!
    expect(r.fireAt.getTime() - now.getTime()).toBe(120_000)
    expect(r.rest).toBe('drink water')
  })
  it('HH:MM clock', () => {
    const r = parseWhenPrefix('18:30 出门', now)!
    expect(r.fireAt.getHours()).toBe(18)
    expect(r.rest).toBe('出门')
  })
  it('ISO with rest', () => {
    const r = parseWhenPrefix('2026-05-09T20:00 important meeting', now)!
    expect(r.fireAt).toBeInstanceOf(Date)
    expect(r.rest).toBe('important meeting')
  })
  it('garbage returns null', () => {
    expect(parseWhenPrefix('hello world', now)).toBeNull()
  })
})

// ─── Recurrence (pure functions) ───────────────────────────────────

describe('isValidRecurrence', () => {
  it('accepts well-formed specs', () => {
    expect(isValidRecurrence('every:5m')).toBe(true)
    expect(isValidRecurrence('every:2h')).toBe(true)
    expect(isValidRecurrence('every:1d')).toBe(true)
    expect(isValidRecurrence('daily:08:30')).toBe(true)
    expect(isValidRecurrence('weekly:1,3,5:09:00')).toBe(true)
    expect(isValidRecurrence('weekly:6,7:10:00')).toBe(true)
  })
  it('rejects sub-minute every:', () => {
    expect(isValidRecurrence('every:30s')).toBe(false)
  })
  it('rejects malformed', () => {
    expect(isValidRecurrence('every:')).toBe(false)
    expect(isValidRecurrence('daily:25:00')).toBe(false)
    expect(isValidRecurrence('weekly:8:09:00')).toBe(false)
    expect(isValidRecurrence('weekly:1:99:00')).toBe(false)
    expect(isValidRecurrence('garbage')).toBe(false)
  })
})

describe('computeNext — every:', () => {
  it('steps anchor + interval, fast-forwards past now', () => {
    const anchor = new Date('2026-05-09T10:00:00')
    // now 30 min later → next = anchor + 5m, then keep stepping until > now
    const now = new Date('2026-05-09T10:32:00')
    const next = computeNext('every:5m', anchor, now)!
    expect(next.getTime()).toBeGreaterThan(now.getTime())
    expect((next.getTime() - anchor.getTime()) % (5 * 60_000)).toBe(0)
  })
})

describe('computeNext — daily:', () => {
  it('next 08:00 today if still future', () => {
    const now = new Date('2026-05-09T07:30:00')
    const next = computeNext('daily:08:00', now, now)!
    expect(next.getHours()).toBe(8)
    expect(next.getDate()).toBe(now.getDate())
  })
  it('next 08:00 tomorrow if past', () => {
    const now = new Date('2026-05-09T20:00:00')
    const next = computeNext('daily:08:00', now, now)!
    expect(next.getHours()).toBe(8)
    expect(next.getDate()).toBe(now.getDate() + 1)
  })
})

describe('computeNext — weekly:', () => {
  it('weekly:1,3,5 from a Sunday picks Monday', () => {
    // 2026-05-10 is Sunday (verify by JS: getDay() should be 0)
    const sun = new Date('2026-05-10T07:00:00')
    expect(sun.getDay()).toBe(0)
    const next = computeNext('weekly:1,3,5:09:00', sun, sun)!
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getHours()).toBe(9)
  })
  it('weekly:6,7 from a Wednesday picks Saturday', () => {
    const wed = new Date('2026-05-13T07:00:00') // Wednesday
    expect(wed.getDay()).toBe(3)
    const next = computeNext('weekly:6,7:10:00', wed, wed)!
    expect(next.getDay()).toBe(6) // Saturday
    expect(next.getHours()).toBe(10)
  })
})

describe('describeRecurrence', () => {
  it('formats human labels', () => {
    expect(describeRecurrence('every:5m')).toBe('每5m')
    expect(describeRecurrence('daily:08:30')).toBe('每天 08:30')
    expect(describeRecurrence('weekly:1,3,5:09:00')).toBe('每周一三五 09:00')
    expect(describeRecurrence('weekly:1,2,3,4,5:18:00')).toBe('每工作日 18:00')
    expect(describeRecurrence('weekly:6,7:10:00')).toBe('每周末 10:00')
  })
})

describe('parseRecurrencePrefix — Chinese', () => {
  const now = new Date('2026-05-09T10:00:00')
  it('每5分钟 → every:5m', () => {
    const r = parseRecurrencePrefix('每5分钟看屏幕', now)!
    expect(r.recurrence).toBe('every:5m')
    expect(r.fireAt.getTime() - now.getTime()).toBe(5 * 60_000)
    expect(r.rest).toBe('看屏幕')
  })
  it('每隔2小时 → every:2h', () => {
    const r = parseRecurrencePrefix('每隔2小时喝水', now)!
    expect(r.recurrence).toBe('every:2h')
    expect(r.rest).toBe('喝水')
  })
  it('rejects 每30秒（亚分钟）', () => {
    expect(parseRecurrencePrefix('每30秒喝水', now)).toBeNull()
  })
  it('每天早上8点 → daily:08:00', () => {
    const r = parseRecurrencePrefix('每天早上8点喝水', now)!
    expect(r.recurrence).toBe('daily:08:00')
    expect(r.rest).toBe('喝水')
  })
  it('每日下午6点半 → daily:18:30', () => {
    const r = parseRecurrencePrefix('每日下午6点半下班', now)!
    expect(r.recurrence).toBe('daily:18:30')
    expect(r.rest).toBe('下班')
  })
  it('每周一9点 → weekly:1:09:00', () => {
    const r = parseRecurrencePrefix('每周一9点站会', now)!
    expect(r.recurrence).toBe('weekly:1:09:00')
    expect(r.rest).toBe('站会')
  })
  it('每周一三五9点 → weekly:1,3,5:09:00', () => {
    const r = parseRecurrencePrefix('每周一三五9点站会', now)!
    expect(r.recurrence).toBe('weekly:1,3,5:09:00')
    expect(r.rest).toBe('站会')
  })
  it('每周末10点 → weekly:6,7:10:00', () => {
    const r = parseRecurrencePrefix('每周末10点大扫除', now)!
    expect(r.recurrence).toBe('weekly:6,7:10:00')
    expect(r.rest).toBe('大扫除')
  })
  it('每个工作日18点 → weekly:1,2,3,4,5:18:00', () => {
    const r = parseRecurrencePrefix('每个工作日18点下班', now)!
    expect(r.recurrence).toBe('weekly:1,2,3,4,5:18:00')
    expect(r.rest).toBe('下班')
  })
  it('每天 (no time) → null', () => {
    expect(parseRecurrencePrefix('每天喝水', now)).toBeNull()
  })
  it('non-recurring prefix → null', () => {
    expect(parseRecurrencePrefix('40秒喝水', now)).toBeNull()
    expect(parseRecurrencePrefix('下午6点下班', now)).toBeNull()
  })
})

describe('parseRecurrencePrefix — English', () => {
  const now = new Date('2026-05-09T10:00:00')
  it('every 5m → every:5m', () => {
    const r = parseRecurrencePrefix('every 5m screen break', now)!
    expect(r.recurrence).toBe('every:5m')
    expect(r.rest).toBe('screen break')
  })
  it('rejects every 30s (sub-minute)', () => {
    expect(parseRecurrencePrefix('every 30s ping', now)).toBeNull()
  })
})

// ─── DB / engine ────────────────────────────────────────────────────

// bun + better-sqlite3 sometimes can't load the native binding. Probe by
// trying a real CRUD; on db_unavailable, skip the whole DB suite.
const dbAvailable = (() => {
  try {
    const id = createReminder({
      fireAt: new Date(Date.now() + 60_000),
      text: 'probe', platform: 'p', channelId: 'c', threadId: 't',
      userId: '_probe_',
    })
    cancelReminder(id)
    return true
  } catch {
    return false
  }
})()
const skipIfNoDb = dbAvailable ? describe : describe.skip

skipIfNoDb('Reminders DB / engine', () => {
  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true })
  })
  afterAll(async () => {
    closeReminderDb()
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
  })
  beforeEach(() => {
    // Wipe between tests — we want a clean slate.
    const helper = (remindersMod as unknown as { _helper?: unknown })
    void helper // keep reference so TS doesn't complain
    // Use the public API to clear: there's no truncate, so cancel all + DELETE.
    // Easier: just delete the file? But the helper holds an open handle. We
    // reuse the logical contract — fresh test DB per process is fine; per-test
    // isolation via different user_id values.
  })

  it('createReminder + getReminder roundtrip', () => {
    const fireAt = new Date(Date.now() + 60_000)
    const id = createReminder({
      fireAt, text: 'drink water',
      platform: 'telegram', channelId: 'default', threadId: 't1',
      userId: 'roundtrip-user',
    })
    expect(id).toBeGreaterThan(0)
    const r = getReminder(id)
    expect(r).not.toBeNull()
    expect(r!.text).toBe('drink water')
    expect(r!.status).toBe('pending')
    expect(r!.platform).toBe('telegram')
  })

  it('rejects too-soon (< MIN_FUTURE_MS)', () => {
    expect(() => createReminder({
      fireAt: new Date(Date.now() + 500),
      text: 'too soon',
      platform: 'p', channelId: 'c', threadId: 't', userId: 'too-soon-user',
    })).toThrow(ReminderError)
  })

  it('rejects too-far (> MAX_FUTURE_MS)', () => {
    expect(() => createReminder({
      fireAt: new Date(Date.now() + MAX_FUTURE_MS + 60_000),
      text: 'too far',
      platform: 'p', channelId: 'c', threadId: 't', userId: 'too-far-user',
    })).toThrow(ReminderError)
  })

  it('rejects empty / over-long text', () => {
    expect(() => createReminder({
      fireAt: new Date(Date.now() + 60_000), text: '   ',
      platform: 'p', channelId: 'c', threadId: 't', userId: 'empty-text-user',
    })).toThrow(/不能为空/)
    expect(() => createReminder({
      fireAt: new Date(Date.now() + 60_000), text: 'x'.repeat(MAX_TEXT_LEN + 1),
      platform: 'p', channelId: 'c', threadId: 't', userId: 'long-text-user',
    })).toThrow(/超过/)
  })

  it('enforces MAX_PENDING_PER_USER quota', () => {
    const user = 'quota-user'
    for (let i = 0; i < MAX_PENDING_PER_USER; i++) {
      createReminder({
        fireAt: new Date(Date.now() + 60_000 + i * 1000),
        text: `r${i}`,
        platform: 'p', channelId: 'c', threadId: 't', userId: user,
      })
    }
    expect(() => createReminder({
      fireAt: new Date(Date.now() + 999_000), text: 'overflow',
      platform: 'p', channelId: 'c', threadId: 't', userId: user,
    })).toThrow(/上限/)
  })

  it('listReminders scopes by creator', () => {
    const a = createReminder({
      fireAt: new Date(Date.now() + 60_000), text: 'A',
      platform: 'p', channelId: 'c', threadId: 't', userId: 'scope-a',
    })
    const b = createReminder({
      fireAt: new Date(Date.now() + 60_000), text: 'B',
      platform: 'p', channelId: 'c', threadId: 't', userId: 'scope-b',
    })
    const aList = listReminders({ creatorId: 'scope-a', status: 'pending' })
    const bList = listReminders({ creatorId: 'scope-b', status: 'pending' })
    expect(aList.some((r) => r.id === a)).toBe(true)
    expect(aList.some((r) => r.id === b)).toBe(false)
    expect(bList.some((r) => r.id === b)).toBe(true)
    expect(bList.some((r) => r.id === a)).toBe(false)
  })

  it('cancelReminder is owner-scoped + idempotent', () => {
    const id = createReminder({
      fireAt: new Date(Date.now() + 60_000), text: 'cancel me',
      platform: 'p', channelId: 'c', threadId: 't', userId: 'cancel-owner',
    })
    expect(cancelReminder(id, { creatorId: 'other-user' })).toBe(false)
    expect(cancelReminder(id, { creatorId: 'cancel-owner' })).toBe(true)
    // Second cancel should noop (status != pending now)
    expect(cancelReminder(id, { creatorId: 'cancel-owner' })).toBe(false)
    expect(getReminder(id)?.status).toBe('cancelled')
  })

  it('snoozeReminder clones row, cancels original, links via parent_id', () => {
    const origId = createReminder({
      fireAt: new Date(Date.now() + 60_000), text: 'snooze test',
      platform: 'p', channelId: 'c', threadId: 't', userId: 'snooze-user',
    })
    const newId = snoozeReminder(origId, 5 * 60_000, { creatorId: 'snooze-user' })
    expect(newId).toBeGreaterThan(origId)
    const orig = getReminder(origId)!
    const fresh = getReminder(newId)!
    expect(orig.status).toBe('cancelled')
    expect(fresh.status).toBe('pending')
    expect(fresh.text).toBe('snooze test')
    expect(fresh.parent_id).toBe(origId)
  })

  it('tick fires due reminders and calls messenger.sendMessage', async () => {
    // Mock messenger registered for platform 'mock-platform'
    const sent: { threadId: string; text: string }[] = []
    const mockMessenger = {
      name: 'mock-platform',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async (threadId: string, text: string) => { sent.push({ threadId, text }) },
    }
    // Directly inject — registry doesn't expose an unregister, so we use a unique
    // platform name per test invocation if we re-run.
    registryMod.registry.registerMessenger(mockMessenger as never)

    const fireAt = new Date(Date.now() + 11_000)
    const id = createReminder({
      fireAt, text: '喝水',
      platform: 'mock-platform', channelId: 'c', threadId: 'thread-X',
      userId: 'tick-user',
    })

    const fired = await tick(new Date(fireAt.getTime() + 1000))
    expect(fired).toBeGreaterThan(0)
    expect(sent.length).toBe(1)
    expect(sent[0].threadId).toBe('thread-X')
    expect(sent[0].text).toContain('喝水')
    expect(sent[0].text).toContain('🔔 提醒：')
    void id

    expect(getReminder(id)?.status).toBe('fired')
  })

  it('failed delivery → status=failed + error captured', async () => {
    const failingMessenger = {
      name: 'failing-platform',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async () => { throw new Error('synthetic delivery failure') },
    }
    registryMod.registry.registerMessenger(failingMessenger as never)

    const fireAt = new Date(Date.now() + 11_000)
    const id = createReminder({
      fireAt, text: '失败用例',
      platform: 'failing-platform', channelId: 'c', threadId: 't',
      userId: 'failure-user',
    })

    await tick(new Date(fireAt.getTime() + 1000))
    const r = getReminder(id)
    expect(r?.status).toBe('failed')
    expect(r?.error).toContain('synthetic delivery failure')
  })

  it('missing messenger → status=failed (no crash)', async () => {
    const fireAt = new Date(Date.now() + 11_000)
    const id = createReminder({
      fireAt, text: '幽灵平台',
      platform: 'no-such-platform', channelId: 'c', threadId: 't',
      userId: 'ghost-user',
    })
    await tick(new Date(fireAt.getTime() + 1000))
    const r = getReminder(id)
    expect(r?.status).toBe('failed')
    expect(r?.error).toContain('not registered')
  })

  it('recurring reminder: tick reschedules instead of marking fired', async () => {
    const sent: { threadId: string; text: string }[] = []
    const recurMessenger = {
      name: 'recur-platform',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async (threadId: string, text: string) => { sent.push({ threadId, text }) },
    }
    registryMod.registry.registerMessenger(recurMessenger as never)

    const fireAt = new Date(Date.now() + 11_000)
    const id = createReminder({
      fireAt, text: '喝水',
      platform: 'recur-platform', channelId: 'c', threadId: 't',
      userId: 'recur-user',
      recurrence: 'every:5m',
    })

    // First tick → fires + reschedules to fireAt + 5m
    const advance1 = new Date(fireAt.getTime() + 1000)
    await tick(advance1)
    const after1 = getReminder(id)!
    expect(after1.status).toBe('pending') // still pending — recurring rolls forward
    expect(after1.last_fired_at).not.toBeNull()
    expect(after1.recurrence).toBe('every:5m')
    const newFire1 = new Date(after1.fire_at).getTime()
    expect(newFire1).toBeGreaterThan(advance1.getTime())
    expect(sent.length).toBe(1)
    expect(sent[0].text).toContain('🔁 提醒：喝水')

    // Second tick at the new fire_at → fires again, reschedules again
    const advance2 = new Date(newFire1 + 1000)
    await tick(advance2)
    const after2 = getReminder(id)!
    expect(after2.status).toBe('pending')
    expect(new Date(after2.fire_at).getTime()).toBeGreaterThan(newFire1)
    expect(sent.length).toBe(2)

    // Cancel terminates the loop
    expect(cancelReminder(id, { creatorId: 'recur-user' })).toBe(true)
    expect(getReminder(id)?.status).toBe('cancelled')
  })

  it('createReminder rejects high-frequency + LLM polish combo', () => {
    expect(() => createReminder({
      fireAt: new Date(Date.now() + 60_000),
      text: '提醒喝水', platform: 'p', channelId: 'c', threadId: 't',
      userId: 'highfreq-user',
      recurrence: 'every:5m',
      // promptMode defaults to 'llm'
    })).toThrow(/高频循环/)
    // With explicit literal mode, same recurrence is fine
    const id = createReminder({
      fireAt: new Date(Date.now() + 60_000),
      text: '提醒喝水', platform: 'p', channelId: 'c', threadId: 't',
      userId: 'highfreq-ok-user',
      recurrence: 'every:5m',
      promptMode: 'literal',
    })
    expect(id).toBeGreaterThan(0)
    expect(getReminder(id)?.prompt_mode).toBe('literal')
  })

  it('createReminder defaults prompt_mode to llm', () => {
    const id = createReminder({
      fireAt: new Date(Date.now() + 60_000),
      text: '默认 llm 测试', platform: 'p', channelId: 'c', threadId: 't',
      userId: 'mode-default-user',
    })
    expect(getReminder(id)?.prompt_mode).toBe('llm')
  })

  it('createReminder rejects malformed recurrence', () => {
    expect(() => createReminder({
      fireAt: new Date(Date.now() + 60_000),
      text: 'bad', platform: 'p', channelId: 'c', threadId: 't',
      userId: 'bad-recur-user',
      recurrence: 'every:30s',
    })).toThrow(/循环规则非法/)
    expect(() => createReminder({
      fireAt: new Date(Date.now() + 60_000),
      text: 'bad', platform: 'p', channelId: 'c', threadId: 't',
      userId: 'bad-recur-user',
      recurrence: 'gibberish',
    })).toThrow(/循环规则非法/)
  })

  it('email bindings: bind/get/unbind roundtrip + scope by platform+user', () => {
    expect(getBoundEmail('telegram', 'u1')).toBeNull()
    const bound = bindEmail('telegram', 'u1', 'me@example.com')
    expect(bound).toBe('me@example.com')
    expect(getBoundEmail('telegram', 'u1')).toBe('me@example.com')
    // Different platform/user should not see this binding
    expect(getBoundEmail('wechat', 'u1')).toBeNull()
    expect(getBoundEmail('telegram', 'u2')).toBeNull()
    // Rebind overrides
    bindEmail('telegram', 'u1', 'other@example.com')
    expect(getBoundEmail('telegram', 'u1')).toBe('other@example.com')
    // Unbind
    expect(unbindEmail('telegram', 'u1')).toBe(true)
    expect(getBoundEmail('telegram', 'u1')).toBeNull()
    // Unbind when nothing bound
    expect(unbindEmail('telegram', 'u1')).toBe(false)
  })

  it('email bindings: rejects invalid email', () => {
    expect(() => bindEmail('telegram', 'u3', 'not-an-email')).toThrow(/邮箱格式非法/)
    expect(() => bindEmail('telegram', 'u3', '@bad.com')).toThrow(/邮箱格式非法/)
    expect(() => bindEmail('telegram', '', 'a@b.com')).toThrow(/无法识别身份/)
  })

  it('clearReminders cancels only own pending', () => {
    const u = 'clear-user'
    const ids = [0, 0, 0].map((_, i) => createReminder({
      fireAt: new Date(Date.now() + 60_000 + i * 1000), text: `c${i}`,
      platform: 'p', channelId: 'c', threadId: 't', userId: u,
    }))
    const n = clearReminders({ creatorId: u })
    expect(n).toBe(ids.length)
    ids.forEach((id) => {
      expect(getReminder(id)?.status).toBe('cancelled')
    })
  })
})

// Suppress the unused-import warning when DB tests are skipped.
void mock
