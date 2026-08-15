// Reminders — lightweight, one-shot, persistent timers.
//
// Scope: "remind me to drink water in 2 minutes". Distinct from schedule.ts
// (cron-driven, agent-spawning) — reminders fire once and just deliver a
// plain text back to the originating IM thread via the registry's
// MessengerAdapter.sendMessage. No LLM is invoked, no Job is created.
//
// Storage: a dedicated SQLite file (~/.agim/reminders.db) using the
// same fail-soft helper as audit-log / job-board / schedule. Engine is a
// 5-second tick; pending rows survive process restart.

import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'
import { registry } from './registry.js'
import { callHelperAgent } from './agent-helper.js'
import { sink } from './message-sink.js'

const REMINDERS_DB = process.env.AGIM_REMINDERS_DB
  ?? join(AGIM_HOME, 'reminders.db')
const TICK_INTERVAL_MS = 5 * 1000
const BATCH_SIZE = 50

export const MAX_PENDING_PER_USER = 50
export const MIN_FUTURE_MS = 10 * 1000               // ≥ 10s
export const MAX_FUTURE_MS = 7 * 24 * 60 * 60 * 1000 // ≤ 7d
export const MAX_TEXT_LEN = 1000
const LATE_THRESHOLD_MS = 60 * 60 * 1000             // > 1h late → tag delivery as ⏰ delayed

const log = rootLogger.child({ component: 'reminders' })
let tickTimer: ReturnType<typeof setInterval> | null = null

// ─── Schema ──────────────────────────────────────────────────────────

const helper = createSqliteHelper({
  file: REMINDERS_DB,
  component: 'reminders',
  logger: rootLogger,
  schema: `
    CREATE TABLE IF NOT EXISTS reminders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      fire_at       TEXT    NOT NULL,
      text          TEXT    NOT NULL,
      platform      TEXT    NOT NULL,
      channel_id    TEXT    NOT NULL,
      thread_id     TEXT    NOT NULL,
      user_id       TEXT    NOT NULL DEFAULT '',
      status        TEXT    NOT NULL DEFAULT 'pending',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      fired_at      TEXT,
      error         TEXT,
      source        TEXT    NOT NULL DEFAULT 'slash',
      parent_id     INTEGER,
      recurrence    TEXT,
      last_fired_at TEXT,
      prompt_mode   TEXT NOT NULL DEFAULT 'llm'
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_fire_at ON reminders(fire_at, status);
    CREATE INDEX IF NOT EXISTS idx_reminders_user    ON reminders(user_id, status);

    -- Email bindings: (platform, user_id) -> email. Co-located here because
    -- it's the same lifetime / ownership scope as a reminder owner. One row
    -- per IM-user; UPSERT on rebind. Unbind = DELETE.
    CREATE TABLE IF NOT EXISTS user_email_bindings (
      platform   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      email      TEXT NOT NULL,
      bound_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, user_id)
    );

    -- Reminder-intent watch settings: per-IM-user toggle for the LLM
    -- detector that watches non-slash messages and proposes reminders.
    -- Default on (no row = enabled). Off via /remind aiwatch off.
    CREATE TABLE IF NOT EXISTS user_aiwatch_settings (
      platform TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      enabled  INTEGER NOT NULL DEFAULT 1,
      set_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, user_id)
    );
  `,
  init: (d) => {
    // Migration: add recurrence + last_fired_at columns to existing DBs.
    const cols = d.pragma('table_info(reminders)') as Array<{ name: string }>
    const have = new Set(cols.map((c) => c.name))
    if (!have.has('recurrence')) d.exec('ALTER TABLE reminders ADD COLUMN recurrence TEXT')
    if (!have.has('last_fired_at')) d.exec('ALTER TABLE reminders ADD COLUMN last_fired_at TEXT')
    if (!have.has('prompt_mode')) {
      d.exec("ALTER TABLE reminders ADD COLUMN prompt_mode TEXT NOT NULL DEFAULT 'llm'")
    }

    // Crash recovery: any row stuck in 'firing' means we crashed mid-deliver.
    // Reset to 'pending' so the next tick retries.
    d.prepare("UPDATE reminders SET status = 'pending' WHERE status = 'firing'").run()
  },
})

function getDb(): Database.Database | null {
  return helper.get()
}

// ─── Types ────────────────────────────────────────────────────────────

export type ReminderStatus = 'pending' | 'firing' | 'fired' | 'cancelled' | 'failed'
export type PromptMode = 'literal' | 'llm'

export interface Reminder {
  id: number
  fire_at: string
  text: string
  platform: string
  channel_id: string
  thread_id: string
  user_id: string
  status: ReminderStatus
  created_at: string
  fired_at: string | null
  error: string | null
  source: string
  parent_id: number | null
  recurrence: string | null
  last_fired_at: string | null
  /** 'llm' = at fire time, treat `text` as a prompt and ask the active
   *  agent to compose the actual delivery. 'literal' = deliver `text` as-is. */
  prompt_mode: PromptMode
}

export interface CreateReminderInput {
  fireAt: Date
  text: string
  platform: string
  channelId: string
  threadId: string
  userId: string
  source?: 'slash' | 'mcp' | 'api'
  parentId?: number
  /** Recurrence spec: `every:5m` / `daily:HH:MM` / `weekly:1,3,5:HH:MM`.
   *  When set, the row stays `pending` after each fire and `fire_at` is rolled
   *  forward to the next occurrence. Cancel via /remind cancel <id>. */
  recurrence?: string
  /** Default 'llm'. Set 'literal' to bypass LLM polish and deliver text as-is. */
  promptMode?: PromptMode
}

export interface OwnerOpts {
  /** When set, list/get/cancel/snooze only see rows where user_id matches
   *  OR is empty (legacy/system rows). Same model as schedule.ts. */
  creatorId?: string
}

export class ReminderError extends Error {
  constructor(public code: string, msg: string) { super(msg) }
}

// ─── Time parsing ────────────────────────────────────────────────────

/** "2m" / "90s" / "3h" / "1d" → milliseconds. Rejects 0/negative/non-int. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(s.trim())
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  const mult: Record<string, number> = {
    s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000,
  }
  return n * mult[m[2]]
}

/** "18:30" → today's 18:30 if still in the future, else tomorrow's 18:30.
 *  Uses server TZ (override at process level via TZ=… env). */
export function parseClock(s: string, now: Date = new Date()): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number.parseInt(m[1], 10)
  const mi = Number.parseInt(m[2], 10)
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  const fire = new Date(now)
  fire.setHours(h, mi, 0, 0)
  if (fire.getTime() <= now.getTime()) {
    fire.setDate(fire.getDate() + 1)
  }
  return fire
}

/** ISO-ish absolute datetime "2026-05-09T20:00" / "2026-05-09T20:00:00Z" etc.
 *  Trailing seconds and timezone suffix are optional. */
export function parseISO(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s.trim())) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Unified parser tried in order: duration → clock → ISO. */
export function parseWhen(s: string, now: Date = new Date()):
  | { ok: true; fireAt: Date }
  | { ok: false; reason: string }
{
  const trimmed = s.trim()
  if (!trimmed) return { ok: false, reason: '时间不能为空' }
  const dur = parseDuration(trimmed)
  if (dur !== null) return { ok: true, fireAt: new Date(now.getTime() + dur) }
  const clock = parseClock(trimmed, now)
  if (clock) return { ok: true, fireAt: clock }
  const iso = parseISO(trimmed)
  if (iso) return { ok: true, fireAt: iso }
  return { ok: false, reason: `无法解析时间："${trimmed}"。支持 2m / 90s / 3h / 1d / 18:30 / 2026-05-09T20:00` }
}

// ─── Prefix parsing (CN + EN, separator-optional) ───────────────────

const CN_UNIT_MS: Record<string, number> = {
  '秒': 1_000,
  '分钟': 60_000,
  '分': 60_000,            // bare 分 (rare; resolved by ordering 分钟 first)
  '小时': 3_600_000,
  '钟头': 3_600_000,
  '时': 3_600_000,         // 时 alone is unusual; safer to treat as small-hour
  '天': 86_400_000,
}
// Match longer units first to avoid 分钟 → 分 misparse.
const CN_UNITS_ORDERED = ['分钟', '小时', '钟头', '秒', '分', '时', '天'] as const

/**
 * Greedily consume a Chinese duration prefix from the head: handles atoms
 * like "40秒" "2分钟" "半小时" "1小时20分" "1小时半" "0.5天", with optional
 * trailing 后/内. Returns ms + remainder, or null if no prefix matched.
 */
function consumeChineseDuration(s: string): { ms: number; rest: string } | null {
  let total = 0
  let consumed = 0
  let lastUnit = ''
  while (consumed < s.length) {
    const remaining = s.slice(consumed)
    let matched = false
    for (const u of CN_UNITS_ORDERED) {
      const re = new RegExp(`^(?:(\\d+(?:\\.\\d+)?)|半个?)\\s*${u}\\s*`)
      const m = re.exec(remaining)
      if (m) {
        const num = m[1] ? Number.parseFloat(m[1]) : 0.5
        if (!Number.isFinite(num) || num <= 0) return null
        total += num * CN_UNIT_MS[u]
        consumed += m[0].length
        lastUnit = u
        matched = true
        break
      }
    }
    if (!matched) break
  }
  if (consumed === 0) return null
  // Trailing 半: e.g. "1小时半" = 1.5h
  if (lastUnit && s.slice(consumed).startsWith('半')) {
    total += 0.5 * CN_UNIT_MS[lastUnit]
    consumed += 1
  }
  let rest = s.slice(consumed)
  if (rest.startsWith('后') || rest.startsWith('内')) rest = rest.slice(1)
  return { ms: total, rest: rest.trim() }
}

/**
 * Consume a Chinese clock prefix: "下午6点" / "下午6点半" / "晚上8点45" /
 * "12点半" / "8点". AM/PM via period word. No prefix → uses parseClock's
 * "today if future else tomorrow" rule.
 */
function consumeChineseClock(s: string, now: Date): { fireAt: Date; rest: string } | null {
  const re = /^(早上|上午|中午|下午|晚上|凌晨)?\s*(\d{1,2})\s*(?:点|时)\s*(?:(\d{1,2})\s*(?:分钟|分)?|半)?\s*/
  const m = re.exec(s)
  if (!m?.[2]) return null
  // Reject if no period word AND no 点/时 actually consumed beyond just digits
  // (the regex requires 点|时 so this is implicit).
  let h = Number.parseInt(m[2], 10)
  let mi = 0
  if (m[3]) {
    mi = Number.parseInt(m[3], 10)
  } else if (/半\s*$/.test(m[0])) {
    mi = 30
  }
  const period = m[1]
  if (period === '下午' || period === '晚上') {
    if (h < 12) h += 12
  } else if (period === '中午') {
    h = 12
  }
  // 早上 / 上午 / 凌晨 → leave hour as-is (assume 0-12 range already)
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  const fire = new Date(now)
  fire.setHours(h, mi, 0, 0)
  if (fire.getTime() <= now.getTime()) fire.setDate(fire.getDate() + 1)
  return { fireAt: fire, rest: s.slice(m[0].length).trim() }
}

/** Consume an English duration prefix: "40s" / "2m" / "1h" / "1d", optionally
 *  separated from the rest by whitespace. */
function consumeEnglishDuration(s: string): { ms: number; rest: string } | null {
  const m = /^(\d+)(s|m|h|d)(?=\s|$)\s*/.exec(s)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return { ms: n * mult[m[2]], rest: s.slice(m[0].length).trim() }
}

/** Consume an HH:MM clock prefix. */
function consumeClock(s: string, now: Date): { fireAt: Date; rest: string } | null {
  const m = /^(\d{1,2}):(\d{2})(?=\s|$)\s*/.exec(s)
  if (!m) return null
  const h = Number.parseInt(m[1], 10)
  const mi = Number.parseInt(m[2], 10)
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  const fire = new Date(now)
  fire.setHours(h, mi, 0, 0)
  if (fire.getTime() <= now.getTime()) fire.setDate(fire.getDate() + 1)
  return { fireAt: fire, rest: s.slice(m[0].length).trim() }
}

/** Consume an ISO datetime prefix. */
function consumeISO(s: string): { fireAt: Date; rest: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)\s*/.exec(s)
  if (!m) return null
  const d = new Date(m[1])
  if (Number.isNaN(d.getTime())) return null
  return { fireAt: d, rest: s.slice(m[0].length).trim() }
}

/**
 * Consume a time-expression prefix from the head of `s`, supporting Chinese
 * (no-separator allowed: "40秒喝水" / "下午6点下班") and English/ISO formats.
 * Returns { fireAt, rest } on success, null when nothing matches.
 *
 * This is the main entry point used by the /remind slash handler so users
 * don't need to remember strict syntax.
 */
export function parseWhenPrefix(s: string, now: Date = new Date()):
  | { fireAt: Date; rest: string }
  | null
{
  const trimmed = s.trim()
  if (!trimmed) return null

  const cd = consumeChineseDuration(trimmed)
  if (cd) return { fireAt: new Date(now.getTime() + cd.ms), rest: cd.rest }

  const cc = consumeChineseClock(trimmed, now)
  if (cc) return cc

  const ed = consumeEnglishDuration(trimmed)
  if (ed) return { fireAt: new Date(now.getTime() + ed.ms), rest: ed.rest }

  const ck = consumeClock(trimmed, now)
  if (ck) return ck

  const iso = consumeISO(trimmed)
  if (iso) return iso

  return null
}

// ─── Recurrence ──────────────────────────────────────────────────────

export const MIN_RECURRENCE_INTERVAL_MS = 60 * 1000 // ≥ 1 minute

const DOW_CN: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7,
}

/** Validate a recurrence spec string. Returns true if parseable. */
export function isValidRecurrence(spec: string): boolean {
  if (spec.startsWith('every:')) {
    const ms = parseDuration(spec.slice(6))
    return ms !== null && ms >= MIN_RECURRENCE_INTERVAL_MS
  }
  if (spec.startsWith('daily:')) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(spec.slice(6))
    if (!m) return false
    const hh = Number.parseInt(m[1], 10), mm = Number.parseInt(m[2], 10)
    return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59
  }
  if (spec.startsWith('weekly:')) {
    const m = /^([\d,]+):(\d{1,2}):(\d{2})$/.exec(spec.slice(7))
    if (!m) return false
    const days = m[1].split(',').map(Number)
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return false
    const hh = Number.parseInt(m[2], 10), mm = Number.parseInt(m[3], 10)
    return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59
  }
  return false
}

/**
 * Compute the next fire time for a recurring reminder.
 *
 * `anchor` is the previous fire_at (for `every:` we step forward from there;
 * if we missed cycles while offline, we fast-forward past `now`). For clock-
 * based recurrences (daily/weekly) anchor is ignored — we always pick the
 * next future slot from `now`.
 *
 * Returns null if the spec is malformed or has no satisfiable next slot.
 */
export function computeNext(spec: string, anchor: Date, now: Date): Date | null {
  if (spec.startsWith('every:')) {
    const dur = parseDuration(spec.slice(6))
    if (dur === null || dur < MIN_RECURRENCE_INTERVAL_MS) return null
    let next = new Date(anchor.getTime() + dur)
    while (next.getTime() <= now.getTime()) {
      next = new Date(next.getTime() + dur)
    }
    return next
  }
  if (spec.startsWith('daily:')) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(spec.slice(6))
    if (!m) return null
    const hh = Number.parseInt(m[1], 10), mm = Number.parseInt(m[2], 10)
    if (hh > 23 || mm > 59) return null
    const next = new Date(now)
    next.setHours(hh, mm, 0, 0)
    while (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1)
    }
    return next
  }
  if (spec.startsWith('weekly:')) {
    const body = spec.slice(7)
    const m = /^([\d,]+):(\d{1,2}):(\d{2})$/.exec(body)
    if (!m) return null
    const days = m[1].split(',').map(Number).filter((d) => d >= 1 && d <= 7)
    if (!days.length) return null
    const hh = Number.parseInt(m[2], 10), mm = Number.parseInt(m[3], 10)
    if (hh > 23 || mm > 59) return null
    for (let i = 0; i <= 7; i++) {
      const cand = new Date(now)
      cand.setDate(cand.getDate() + i)
      cand.setHours(hh, mm, 0, 0)
      const jsDay = cand.getDay() // 0=Sun..6=Sat
      const dow = jsDay === 0 ? 7 : jsDay
      if (days.includes(dow) && cand.getTime() > now.getTime()) return cand
    }
    return null
  }
  return null
}

/** Human-readable recurrence label for /remind list. */
export function describeRecurrence(spec: string): string {
  if (spec.startsWith('every:')) return `每${spec.slice(6)}`
  if (spec.startsWith('daily:')) return `每天 ${spec.slice(6)}`
  if (spec.startsWith('weekly:')) {
    const body = spec.slice(7)
    const m = /^([\d,]+):(\d{1,2}:\d{2})$/.exec(body)
    if (!m) return spec
    const days = m[1].split(',').map(Number).sort()
    const dayLabels: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
    const isWorkday = days.length === 5 && days.join(',') === '1,2,3,4,5'
    const isWeekend = days.length === 2 && days.join(',') === '6,7'
    const label = isWorkday ? '工作日' : isWeekend ? '周末' : `周${days.map((d) => dayLabels[d]).join('')}`
    return `每${label} ${m[2]}`
  }
  return spec
}

/** Try Chinese-clock first, fall back to HH:MM — for recurrence "X 点 / X:MM". */
function consumeClockEither(s: string, now: Date): { fireAt: Date; rest: string } | null {
  return consumeChineseClock(s, now) ?? consumeClock(s, now)
}

/**
 * Consume a recurrence prefix from the head of `s`. Supports:
 *
 *   每5分钟 / 每隔5分钟 / 每2小时 / 每30秒（拒绝, 不做亚分钟级）
 *   每天早上8点 / 每日下午6点半 / 每天8:30
 *   每周一8点 / 每周一三五9点 / 每周末10点 / 每个工作日9点
 *   every 5m / every 1h
 *
 * Returns `{ recurrence, fireAt, rest }` where `fireAt` is the FIRST occurrence
 * (≥ now). `null` when no recurrence pattern matched.
 */
export function parseRecurrencePrefix(s: string, now: Date = new Date()):
  | { recurrence: string; fireAt: Date; rest: string }
  | null
{
  const trimmed = s.trim()
  if (!trimmed) return null

  // ── English: "every 5m" / "every 1h" / "every 1d" ────────────────
  const enEvery = /^every\s+(\d+)(s|m|h|d)(?=\s|$)\s*/i.exec(trimmed)
  if (enEvery) {
    const n = Number.parseInt(enEvery[1], 10)
    const unit = enEvery[2].toLowerCase()
    const ms = n * (unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000)
    if (ms < MIN_RECURRENCE_INTERVAL_MS) return null
    return {
      recurrence: `every:${n}${unit}`,
      fireAt: new Date(now.getTime() + ms),
      rest: trimmed.slice(enEvery[0].length).trim(),
    }
  }

  // ── Chinese: must start with 每[隔]? ─────────────────────────────
  const everyMatch = /^每(?:隔)?\s*/.exec(trimmed)
  if (!everyMatch) return null
  const after = trimmed.slice(everyMatch[0].length)

  // 每个工作日 X 点 → weekly:1,2,3,4,5
  const wdMatch = /^(?:个)?工作日\s*/.exec(after)
  if (wdMatch) {
    const cc = consumeClockEither(after.slice(wdMatch[0].length).trim(), now)
    if (!cc) return null
    const hh = String(cc.fireAt.getHours()).padStart(2, '0')
    const mm = String(cc.fireAt.getMinutes()).padStart(2, '0')
    const recurrence = `weekly:1,2,3,4,5:${hh}:${mm}`
    const first = computeNext(recurrence, now, new Date(now.getTime() - 1))
    if (!first) return null
    return { recurrence, fireAt: first, rest: cc.rest }
  }

  // 每周末 X 点 → weekly:6,7
  if (after.startsWith('周末')) {
    const cc = consumeClockEither(after.slice(2).trim(), now)
    if (!cc) return null
    const hh = String(cc.fireAt.getHours()).padStart(2, '0')
    const mm = String(cc.fireAt.getMinutes()).padStart(2, '0')
    const recurrence = `weekly:6,7:${hh}:${mm}`
    const first = computeNext(recurrence, now, new Date(now.getTime() - 1))
    if (!first) return null
    return { recurrence, fireAt: first, rest: cc.rest }
  }

  // 每周一 / 每周一三五 / 每周二四 → weekly:days
  if (after.startsWith('周')) {
    const afterZhou = after.slice(1)
    const days: number[] = []
    let i = 0
    while (i < afterZhou.length) {
      const ch = afterZhou[i]
      if (DOW_CN[ch] !== undefined) {
        days.push(DOW_CN[ch])
        i++
      } else {
        break
      }
    }
    if (!days.length) return null
    const cc = consumeClockEither(afterZhou.slice(i).trim(), now)
    if (!cc) return null
    const hh = String(cc.fireAt.getHours()).padStart(2, '0')
    const mm = String(cc.fireAt.getMinutes()).padStart(2, '0')
    const uniqDays = [...new Set(days)].sort((a, b) => a - b)
    const recurrence = `weekly:${uniqDays.join(',')}:${hh}:${mm}`
    const first = computeNext(recurrence, now, new Date(now.getTime() - 1))
    if (!first) return null
    return { recurrence, fireAt: first, rest: cc.rest }
  }

  // 每天 / 每日 [time] → daily:HH:MM
  if (after.startsWith('天') || after.startsWith('日')) {
    const afterDay = after.slice(1).trim()
    const cc = consumeClockEither(afterDay, now)
    if (!cc) return null
    const hh = String(cc.fireAt.getHours()).padStart(2, '0')
    const mm = String(cc.fireAt.getMinutes()).padStart(2, '0')
    return {
      recurrence: `daily:${hh}:${mm}`,
      fireAt: cc.fireAt,
      rest: cc.rest,
    }
  }

  // 每N(分钟|小时|秒|天) → every:Nu (reject sub-minute)
  for (const u of CN_UNITS_ORDERED) {
    const re = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${u}\\s*`)
    const m = re.exec(after)
    if (m) {
      const n = Number.parseFloat(m[1])
      if (!Number.isFinite(n) || n <= 0) return null
      const ms = n * CN_UNIT_MS[u]
      if (ms < MIN_RECURRENCE_INTERVAL_MS) return null
      const shortUnit = u === '秒'
        ? 's'
        : (u === '分钟' || u === '分')
          ? 'm'
          : (u === '小时' || u === '钟头' || u === '时')
            ? 'h'
            : 'd'
      // Use integer count when the input was integer (no .5)
      const count = Number.isInteger(n) ? String(n) : String(n)
      return {
        recurrence: `every:${count}${shortUnit}`,
        fireAt: new Date(now.getTime() + ms),
        rest: after.slice(m[0].length).trim(),
      }
    }
  }

  return null
}

// ─── CRUD ────────────────────────────────────────────────────────────

function countPendingForUser(d: Database.Database, userId: string): number {
  const row = d.prepare(
    "SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND status IN ('pending','firing')"
  ).get(userId) as { n: number }
  return row.n
}

export function createReminder(input: CreateReminderInput): number {
  const d = getDb()
  if (!d) throw new ReminderError('db_unavailable', '提醒功能未就绪（SQLite 不可用）')

  const text = input.text.trim()
  if (!text) throw new ReminderError('text_empty', '提醒内容不能为空')
  if (text.length > MAX_TEXT_LEN) {
    throw new ReminderError('text_too_long', `提醒内容超过 ${MAX_TEXT_LEN} 字符`)
  }

  const now = Date.now()
  const delta = input.fireAt.getTime() - now
  if (delta < MIN_FUTURE_MS) {
    throw new ReminderError('too_soon', `触发时间必须至少 ${MIN_FUTURE_MS / 1000} 秒之后`)
  }
  if (delta > MAX_FUTURE_MS) {
    throw new ReminderError('too_far', '触发时间不能超过 7 天后；如需更长周期请用 /cron')
  }

  if (input.userId) {
    const n = countPendingForUser(d, input.userId)
    if (n >= MAX_PENDING_PER_USER) {
      throw new ReminderError('quota_exceeded',
        `待发提醒已达上限 ${MAX_PENDING_PER_USER} 条；先 /remind clear 清理`)
    }
  }

  let recurrence: string | null = null
  if (input.recurrence !== undefined) {
    if (!isValidRecurrence(input.recurrence)) {
      throw new ReminderError('bad_recurrence', `循环规则非法："${input.recurrence}"`)
    }
    recurrence = input.recurrence
  }

  const promptMode: PromptMode = input.promptMode ?? 'llm'

  // High-frequency + LLM polish → refuse. Why: 每5分钟 × LLM 调用 = burst
  // load on whichever agent the user has registered (claude-code subprocess
  // restart, opencode HTTP, codex CLI), independent of any cost concerns.
  // The user can either lengthen the interval or pass promptMode='literal'.
  if (promptMode === 'llm' && recurrence?.startsWith('every:')) {
    const intervalMs = parseDuration(recurrence.slice(6))
    if (intervalMs !== null && intervalMs < 60 * 60_000) {
      throw new ReminderError('high_freq_llm',
        '高频循环（< 1 小时）不能用 LLM 润色——会让你的 agent 频繁触发。' +
        '改用更长间隔，或加 `literal` 子命令保持字面文本。')
    }
  }

  const info = d.prepare(
    `INSERT INTO reminders
       (fire_at, text, platform, channel_id, thread_id, user_id, source, parent_id, recurrence, prompt_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.fireAt.toISOString(), text,
    input.platform, input.channelId, input.threadId, input.userId,
    input.source || 'slash',
    input.parentId ?? null,
    recurrence,
    promptMode,
  )
  return Number(info.lastInsertRowid)
}

export function listReminders(opts: OwnerOpts & { status?: ReminderStatus; limit?: number } = {}): Reminder[] {
  const d = getDb()
  if (!d) return []
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.creatorId !== undefined) {
    conditions.push("(user_id = ? OR user_id = '')")
    params.push(opts.creatorId)
  }
  if (opts.status) {
    conditions.push('status = ?')
    params.push(opts.status)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return d.prepare(
    `SELECT * FROM reminders ${where} ORDER BY fire_at ASC LIMIT ?`
  ).all(...params, opts.limit ?? 50) as Reminder[]
}

export function getReminder(id: number, opts: OwnerOpts = {}): Reminder | null {
  const d = getDb()
  if (!d) return null
  const row = (opts.creatorId !== undefined
    ? d.prepare("SELECT * FROM reminders WHERE id = ? AND (user_id = ? OR user_id = '')").get(id, opts.creatorId)
    : d.prepare('SELECT * FROM reminders WHERE id = ?').get(id)) as Reminder | undefined
  return row || null
}

export function cancelReminder(id: number, opts: OwnerOpts = {}): boolean {
  const d = getDb()
  if (!d) return false
  // Only cancel rows that are still pending — fired/cancelled/failed are terminal.
  if (opts.creatorId !== undefined) {
    return d.prepare(
      `UPDATE reminders SET status = 'cancelled'
       WHERE id = ? AND status = 'pending' AND (user_id = ? OR user_id = '')`
    ).run(id, opts.creatorId).changes > 0
  }
  return d.prepare(
    "UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(id).changes > 0
}

export function clearReminders(opts: { creatorId: string }): number {
  const d = getDb()
  if (!d) return 0
  return d.prepare(
    "UPDATE reminders SET status = 'cancelled' WHERE status = 'pending' AND user_id = ?"
  ).run(opts.creatorId).changes
}

/** Snooze an existing reminder by `deltaMs`: clones the row's text and target
 *  thread to a new pending row, then marks the original 'cancelled' (if still
 *  pending) or just chains parent_id (if already fired). Returns new id. */
export function snoozeReminder(id: number, deltaMs: number, opts: OwnerOpts = {}): number {
  const d = getDb()
  if (!d) throw new ReminderError('db_unavailable', '提醒功能未就绪')
  const orig = getReminder(id, opts)
  if (!orig) throw new ReminderError('not_found', `找不到提醒 #${id}（或不属于你）`)
  if (deltaMs < MIN_FUTURE_MS) {
    throw new ReminderError('too_soon', `延后时间必须至少 ${MIN_FUTURE_MS / 1000} 秒`)
  }
  const newId = createReminder({
    fireAt: new Date(Date.now() + deltaMs),
    text: orig.text,
    platform: orig.platform,
    channelId: orig.channel_id,
    threadId: orig.thread_id,
    userId: orig.user_id,
    source: 'slash',
    parentId: orig.id,
  })
  // If the original is still pending, cancel it (otherwise both would fire).
  if (orig.status === 'pending') {
    d.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(orig.id)
  }
  return newId
}

// ─── Email bindings ──────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Bind (or rebind) an email address to an IM user. Returns the bound email. */
export function bindEmail(platform: string, userId: string, email: string): string {
  const d = getDb()
  if (!d) throw new ReminderError('db_unavailable', '邮箱绑定功能未就绪')
  const trimmed = email.trim()
  if (!EMAIL_RE.test(trimmed)) throw new ReminderError('bad_email', `邮箱格式非法："${email}"`)
  if (!userId) throw new ReminderError('no_user', '无法识别身份，无法绑定邮箱')
  d.prepare(
    `INSERT INTO user_email_bindings (platform, user_id, email)
     VALUES (?, ?, ?)
     ON CONFLICT(platform, user_id) DO UPDATE SET
       email = excluded.email,
       bound_at = datetime('now')`,
  ).run(platform, userId, trimmed)
  return trimmed
}

/** Look up the bound email for an IM user, or null. */
export function getBoundEmail(platform: string, userId: string): string | null {
  const d = getDb()
  if (!d || !userId) return null
  const row = d.prepare(
    'SELECT email FROM user_email_bindings WHERE platform = ? AND user_id = ?',
  ).get(platform, userId) as { email: string } | undefined
  return row?.email ?? null
}

/** Remove the binding for an IM user. Returns true if a row was deleted. */
export function unbindEmail(platform: string, userId: string): boolean {
  const d = getDb()
  if (!d || !userId) return false
  return d.prepare(
    'DELETE FROM user_email_bindings WHERE platform = ? AND user_id = ?',
  ).run(platform, userId).changes > 0
}

// ─── Context snippet (for agent prompt injection) ───────────────────

const CONTEXT_MAX_REMINDERS = 5
const CONTEXT_MAX_TEXT_LEN = 60

/**
 * Render a compact "background context" block listing the user's pending
 * reminders for the current platform. Used by router.ts to prepend to the
 * agent prompt so the agent has live visibility into the user's queue —
 * lets it answer "what reminders do I have?" without an extra
 * list_reminders tool call, and avoids creating duplicates.
 *
 * Empty string when nothing pending — caller should noop.
 *
 * Cost: ~80-200 tokens per message when populated. Bounded to 5 reminders.
 */
export function buildContextSnippet(platform: string, userId: string): string {
  if (!userId) return ''
  const d = getDb()
  if (!d) return ''
  const rows = d.prepare(
    `SELECT * FROM reminders
     WHERE status = 'pending'
       AND platform = ?
       AND (user_id = ? OR user_id = '')
     ORDER BY fire_at ASC LIMIT ?`
  ).all(platform, userId, CONTEXT_MAX_REMINDERS) as Reminder[]
  if (rows.length === 0) return ''
  const lines = rows.map((r) => {
    const t = new Date(r.fire_at)
    const when = t.toLocaleString()
    const recur = r.recurrence ? ` [${describeRecurrence(r.recurrence)}]` : ''
    const text = r.text.length > CONTEXT_MAX_TEXT_LEN
      ? `${r.text.slice(0, CONTEXT_MAX_TEXT_LEN)}…`
      : r.text
    return `  #${r.id} ${when}${recur}: ${text}`
  })
  return [
    '[agim context — user\'s pending reminders. Use snooze_reminder / cancel_reminder tools to modify; reference these naturally if relevant. Ignore if unrelated to the current message.]',
    ...lines,
    '',
  ].join('\n')
}

// ─── Aiwatch (reminder-intent detector) settings ─────────────────────

/** Whether the LLM intent detector should run for this user's non-slash
 *  messages. Default on (no row = enabled). DB-unavailable also returns
 *  true so users on bun/fail-soft don't lose the feature silently. */
export function isAiwatchEnabled(platform: string, userId: string): boolean {
  const d = getDb()
  if (!d || !userId) return true
  const row = d.prepare(
    'SELECT enabled FROM user_aiwatch_settings WHERE platform = ? AND user_id = ?',
  ).get(platform, userId) as { enabled: number } | undefined
  if (!row) return true
  return row.enabled !== 0
}

/** Set the aiwatch enabled flag. UPSERT semantics. Returns the new value. */
export function setAiwatchEnabled(platform: string, userId: string, enabled: boolean): boolean {
  const d = getDb()
  if (!d || !userId) return enabled
  d.prepare(
    `INSERT INTO user_aiwatch_settings (platform, user_id, enabled, set_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(platform, user_id) DO UPDATE SET
       enabled = excluded.enabled,
       set_at = excluded.set_at`,
  ).run(platform, userId, enabled ? 1 : 0)
  return enabled
}

// ─── Engine ──────────────────────────────────────────────────────────

/**
 * Resolve a vendor-agnostic platform name (`'wechat'`, `'telegram'`, …) to a
 * registered messenger adapter. Some adapters register under specific names
 * like `'wechat-ilink'` while RouteContext.platform stays generic; we walk
 * the registry once and fuzzy-match by `${platform}-*` prefix.
 */
function resolveMessenger(platform: string): ReturnType<typeof registry.getMessenger> {
  const exact = registry.getMessenger(platform)
  if (exact) return exact
  for (const name of registry.listMessengers()) {
    if (name === platform || name.startsWith(`${platform}-`) || name.startsWith(`${platform}_`)) {
      return registry.getMessenger(name)
    }
  }
  return undefined
}

/** Move a failed/cancelled reminder back to pending with a fresh fireAt
 *  (now + MIN_FUTURE_MS). Owner-scoped. Returns true on success. */
export function retryReminder(id: number, opts: OwnerOpts = {}): boolean {
  const d = getDb()
  if (!d) return false
  const r = getReminder(id, opts)
  if (!r) return false
  if (r.status === 'pending' || r.status === 'firing') return false
  const fireAt = new Date(Date.now() + MIN_FUTURE_MS).toISOString()
  return d.prepare(
    `UPDATE reminders SET status = 'pending', fire_at = ?, error = NULL, fired_at = NULL
     WHERE id = ?`
  ).run(fireAt, id).changes > 0
}

function dueReminders(d: Database.Database, now: Date): Reminder[] {
  return d.prepare(
    `SELECT * FROM reminders
     WHERE status = 'pending' AND fire_at <= ?
     ORDER BY fire_at ASC LIMIT ?`
  ).all(now.toISOString(), BATCH_SIZE) as Reminder[]
}

const POLISH_TIMEOUT_MS = 20_000
const POLISH_MAX_OUTPUT = 800

/**
 * System prompt used when prompt_mode === 'llm'. Tone constraints come
 * straight from product feedback: no flattery, no excess humor, no
 * exaggeration. The model is told to act as a *terse* notifier, not a
 * cheerleader. Caller still wraps the result with the 🔔/🔁 prefix.
 */
const POLISH_SYSTEM_PROMPT = [
  '你是一个简短、克制的提醒助手。',
  '收到一条用户给自己的提醒指令后，你需要把它转化为一条要发给用户的中文提醒文本。',
  '',
  '严格遵守：',
  '1. 风格中性、专业、自然，**不要献媚奉承、不要过度幽默、不要夸大夸张**。',
  '2. 输出只是一条提醒，不要打招呼套话（"你好呀！"、"亲爱的"），不要表情包堆砌。',
  '3. 长度 ≤ 80 字。能一句说清就一句。',
  '4. 直接输出最终文本，不要 JSON、不要解释、不要重复指令、不要带"提醒："等前缀（前缀由系统加）。',
  '5. 如果指令本身已经是一句完整、简洁、可投递的话，几乎原样输出即可，别画蛇添足。',
].join('\n')

/**
 * Ask the active agent to compose a delivery message from the literal seed
 * text. Returns the composed text, or null on any failure / timeout / no
 * agent → caller falls back to the literal seed.
 */
async function polishReminderText(r: Reminder, now: Date): Promise<string | null> {
  const userPrompt = [
    `当前时间：${now.toLocaleString()}`,
    r.recurrence ? `（这是一条循环提醒：${r.recurrence}）` : '',
    '',
    `用户的提醒指令：${r.text}`,
  ].filter(Boolean).join('\n')

  const polished = await callHelperAgent({
    platform: r.platform,
    channelId: r.channel_id,
    threadId: r.thread_id,
    systemPrompt: POLISH_SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: POLISH_TIMEOUT_MS,
    maxOutputChars: POLISH_MAX_OUTPUT,
  })
  if (!polished) return null
  // Defensive: collapse multi-line output so it stays one tidy chat bubble.
  // Keep paragraph breaks but strip leading/trailing whitespace per line.
  return polished.split('\n').map((s) => s.trim()).filter(Boolean).join('\n').slice(0, 500)
}

/**
 * Format the delivery payload. Late delivery (> 1h overdue) gets a tagged
 * prefix so the user sees that the bot was offline. Body comes from the
 * pre-composed `body` argument (literal text or LLM polish).
 */
function formatDelivery(r: Reminder, body: string, now: Date): string {
  const fireAt = new Date(r.fire_at)
  const lateMs = now.getTime() - fireAt.getTime()
  const lateTag = lateMs > LATE_THRESHOLD_MS
    ? `⏰ 延迟投递（原计划 ${fireAt.toLocaleString()}）\n`
    : ''
  const icon = r.recurrence ? '🔁' : '🔔'
  return `${lateTag}${icon} 提醒：${body}`
}

async function fireOne(r: Reminder, now: Date): Promise<void> {
  const d = getDb()
  if (!d) return

  // Atomically claim: only proceed if still pending.
  const claim = d.prepare(
    "UPDATE reminders SET status = 'firing' WHERE id = ? AND status = 'pending'"
  ).run(r.id)
  if (claim.changes === 0) return // already taken

  // Pre-flight: confirm an adapter is registered so we can surface a clean
  // "no messenger" failure without enqueueing into outbox first. Sink also
  // does this check, but raising it here lets us record the failure on the
  // reminder row (status='failed', error=...) instead of looping on retries.
  const messenger = resolveMessenger(r.platform)
  if (!messenger) {
    d.prepare("UPDATE reminders SET status = 'failed', error = ? WHERE id = ?")
      .run(`messenger '${r.platform}' not registered`, r.id)
    log.warn({ event: 'reminders.no_messenger', id: r.id, platform: r.platform })
    return
  }

  try {
    // Compose the body. Polish is best-effort: if the helper agent isn't
    // available or times out, fall back to the literal seed text. The user
    // still gets their reminder either way.
    let body = r.text
    if (r.prompt_mode === 'llm') {
      const polished = await polishReminderText(r, now)
      if (polished) {
        body = polished
        log.debug({ event: 'reminders.polished', id: r.id, polishedLen: polished.length })
      } else {
        log.debug({ event: 'reminders.polish_skipped', id: r.id },
          'helper agent unavailable — using literal text')
      }
    }
    await sink.deliver({
      platform: r.platform,
      channelId: r.channel_id,
      threadId: r.thread_id,
      payload: formatDelivery(r, body, now),
      kind: 'text',
      // Idempotency: stable per-occurrence key. If we crash after the outbox
      // handoff but before this reminder is marked terminal, startup recovery
      // resets the row 'firing'→'pending' and it re-fires for the SAME fire_at
      // — the matching dedup_key makes that re-enqueue a no-op, so the user
      // never gets a duplicate.
      dedupKey: `reminder:${r.id}:${r.fire_at}`,
    })
    const firedAtIso = new Date().toISOString()

    if (r.recurrence) {
      // Reschedule to next occurrence; row stays pending. If computeNext returns
      // null (malformed spec — shouldn't happen since we validate on create) we
      // fall back to terminal 'fired' so the row doesn't get stuck.
      const fireAt = new Date(r.fire_at)
      const next = computeNext(r.recurrence, fireAt, now)
      if (next) {
        d.prepare(
          `UPDATE reminders
             SET status = 'pending', fire_at = ?, last_fired_at = ?, error = NULL
           WHERE id = ?`,
        ).run(next.toISOString(), firedAtIso, r.id)
        log.info({
          event: 'reminders.fired_recurring',
          id: r.id, platform: r.platform, threadId: r.thread_id,
          next: next.toISOString(), recurrence: r.recurrence,
        })
        return
      }
      log.warn({ event: 'reminders.recurrence_terminal', id: r.id, recurrence: r.recurrence },
        'computeNext returned null — terminating recurring reminder')
    }

    d.prepare("UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ?")
      .run(firedAtIso, r.id)
    log.info({ event: 'reminders.fired', id: r.id, platform: r.platform, threadId: r.thread_id })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    d.prepare("UPDATE reminders SET status = 'failed', error = ? WHERE id = ?").run(msg, r.id)
    log.warn({ event: 'reminders.failed', id: r.id, platform: r.platform, err: msg })
  }
}

/** Run a single tick. Exposed for tests so they can advance the clock manually. */
export async function tick(now: Date = new Date()): Promise<number> {
  const d = getDb()
  if (!d) return 0
  const due = dueReminders(d, now)
  for (const r of due) {
    await fireOne(r, now).catch((err) => {
      log.error({ id: r.id, err: err instanceof Error ? err.message : String(err) },
        'fireOne threw — leaving row in firing state for next-restart recovery')
    })
  }
  return due.length
}

/** Start the periodic ticker. Idempotent. */
export function startReminderEngine(): void {
  if (tickTimer) return
  tickTimer = setInterval(() => {
    void tick().catch((err) => {
      log.error({ event: 'reminders.tick.unhandled', err: err instanceof Error ? err.message : String(err) },
        'reminder tick threw unhandled')
    })
  }, TICK_INTERVAL_MS)
  if (typeof tickTimer === 'object' && tickTimer && 'unref' in tickTimer) {
    (tickTimer as { unref: () => void }).unref()
  }
  try { pruneOldReminders() } catch { /* best-effort */ }
  log.info({ tickMs: TICK_INTERVAL_MS }, 'Reminder engine started')
}

const REMINDER_RETENTION_DAYS = 14

export function pruneOldReminders(d: Database.Database | null = getDb()): number {
  if (!d) return 0
  try {
    const info = d.prepare(
      `DELETE FROM reminders
        WHERE status IN ('fired', 'cancelled')
          AND COALESCE(fired_at, created_at) < datetime('now', '-' || ? || ' days')`,
    ).run(REMINDER_RETENTION_DAYS)
    if (info.changes > 0) {
      log.info({ event: 'reminders.prune', deleted: info.changes, days: REMINDER_RETENTION_DAYS },
        `Pruned ${info.changes} reminder row(s)`)
    }
    return info.changes
  } catch (err) {
    log.warn({ event: 'reminders.prune_failed', err: String(err) })
    return 0
  }
}

export function stopReminderEngine(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

export function closeReminderDb(): void {
  helper.close()
}
