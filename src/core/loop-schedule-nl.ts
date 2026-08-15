// loop-schedule-nl.ts — cheap NL → cron / mission parse for scheduled Loops.
// Deterministic so the confirmation card does not depend on an LLM for the
// common "每天凌晨2点用 Loop 修登录；退出条件为…" shape.

import { parseLoopStartText } from './loop-run.js'

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

const DOW_CN: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
}

/** Recurring clock + Loop-ish wording. Both required to avoid stealing reminders. */
const RECUR_HINT_RE = /每天|每日|每周|每月|每个工作日|工作日|每隔|every\s+day|weekdays?/i
const LOOP_HINT_RE = /loop|闭环|使命|定时\s*(开|跑|启)|跑\s*一?\s*轮|再跑一?轮|无人值守/i
/** Bare “open a scheduled Loop” — dock fills the rest. */
const OPEN_DRAFT_RE = /开个?\s*定时\s*(loop|闭环)|定时\s*(开|跑|启)\s*(个)?\s*(loop|闭环)|scheduled\s+loop/i

export function looksLikeScheduledLoopAsk(text: string): boolean {
  const t = (text || '').trim()
  if (!t || t.startsWith('/')) return false
  if (OPEN_DRAFT_RE.test(t)) return true
  return RECUR_HINT_RE.test(t) && LOOP_HINT_RE.test(t)
}

export function looksLikeScheduledLoopDraftOpen(text: string): boolean {
  return OPEN_DRAFT_RE.test((text || '').trim())
}

export function parseCnInt(raw: string): number | null {
  const t = (raw || '').trim()
  if (!t) return null
  if (/^\d{1,2}$/.test(t)) return Number(t)
  if (t === '十') return 10
  if (t.startsWith('十') && t.length === 2) {
    const ones = CN_DIGIT[t.charAt(1)]
    return ones === undefined ? null : 10 + ones
  }
  if (t.length === 2 && t[1] === '十') {
    const tens = CN_DIGIT[t.charAt(0)]
    return tens === undefined ? null : tens * 10
  }
  if (t.length === 3 && t[1] === '十') {
    const tens = CN_DIGIT[t.charAt(0)]
    const ones = CN_DIGIT[t.charAt(2)]
    if (tens === undefined || ones === undefined) return null
    return tens * 10 + ones
  }
  return CN_DIGIT[t] ?? null
}

function applyPeriod(hour: number, period: string | undefined): number {
  if (!period) return hour
  if (period === '下午' || period === '晚上') return hour < 12 ? hour + 12 : hour
  if (period === '中午') return hour === 0 || hour === 12 ? 12 : hour
  if (period === '凌晨' && hour === 12) return 0
  return hour
}

function parseClock(chunk: string): { minute: number; hour: number } | null {
  const m = chunk.match(
    /(?:凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?::|：|点)\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})?/,
  )
  if (!m) {
    if (/中午/.test(chunk)) return { hour: 12, minute: 0 }
    if (/凌晨/.test(chunk)) return { hour: 2, minute: 0 }
    return null
  }
  const period = chunk.match(/凌晨|早上|上午|中午|下午|晚上/)?.[0]
  const hourRaw = parseCnInt(m[1] || '')
  if (hourRaw === null || hourRaw < 0 || hourRaw > 23) return null
  const minuteRaw = m[2] ? parseCnInt(m[2]) : 0
  if (minuteRaw === null || minuteRaw < 0 || minuteRaw > 59) return null
  return { hour: applyPeriod(hourRaw, period), minute: minuteRaw }
}

function parseDows(chunk: string): string | null {
  if (/每个工作日|工作日|weekdays?/i.test(chunk)) return '1-5'
  const weekly = chunk.match(/每周([一二三四五六日天]+)/)
  const weeklyDays = weekly?.[1]
  if (!weeklyDays) return null
  const days = [...weeklyDays].map((ch) => DOW_CN[ch]).filter((n): n is number => n !== undefined)
  if (days.length === 0) return null
  return [...new Set(days)].sort((a, b) => a - b).join(',')
}

export interface NlCron {
  cron: string
  label: string
  matched: string
}

/** Best-effort recurring clock → 5-field POSIX cron. Null when not confident. */
export function nlToCron(text: string): NlCron | null {
  const t = (text || '').trim()
  if (!t) return null

  const monthly = t.match(/每月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*号?/)
  const clock = parseClock(t)
  if (!clock) return null

  if (monthly) {
    const day = parseCnInt(monthly[1] || '')
    if (day === null || day < 1 || day > 31) return null
    return {
      cron: `${clock.minute} ${clock.hour} ${day} * *`,
      label: `每月${day}号 ${pad(clock.hour)}:${pad(clock.minute)}`,
      matched: monthly[0] ?? '',
    }
  }

  const dows = parseDows(t)
  if (dows) {
    const label = dows === '1-5'
      ? `每个工作日 ${pad(clock.hour)}:${pad(clock.minute)}`
      : `每周${dows} ${pad(clock.hour)}:${pad(clock.minute)}`
    const matched = t.match(/每个工作日|工作日|每周[一二三四五六日天]+/)?.[0] || ''
    return {
      cron: `${clock.minute} ${clock.hour} * * ${dows}`,
      label,
      matched,
    }
  }

  if (/每天|每日|every\s+day/i.test(t)) {
    const matched = t.match(/每天|每日|every\s+day/i)?.[0] || '每天'
    return {
      cron: `${clock.minute} ${clock.hour} * * *`,
      label: `每天 ${pad(clock.hour)}:${pad(clock.minute)}`,
      matched,
    }
  }

  return null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

const GLUE_RE = new RegExp([
  '用\\s*(一个)?\\s*(loop|Loop|闭环)',
  '跑\\s*一?\\s*轮',
  '再跑一?轮',
  '定时\\s*(开|跑|启动|开启)?',
  '帮我',
  '开启',
  '启动',
].join('|'), 'gi')

export function stripScheduleGlue(text: string, extra?: string): string {
  let out = text
  if (extra) out = out.replace(extra, ' ')
  out = out.replace(
    /(?:每天|每日|每周[一二三四五六日天]+|每个工作日|工作日|每月\s*\d+\s*号?|every\s+day)\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})?\s*(?::|：|点)?\s*(?:\d{1,2})?/gi,
    ' ',
  )
  out = out.replace(/(?:凌晨|早上|上午|中午|下午|晚上)\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*点/g, ' ')
  out = out.replace(GLUE_RE, ' ')
  return out.replace(/[\s,，。]+/g, ' ').trim()
}

export function parseScheduledLoopMission(text: string): {
  objective: string
  exitDescription: string
  headless: boolean
} {
  const parsed = parseLoopStartText(text)
  const headless = /无人值守|headless/i.test(text)
  return {
    objective: (parsed.objective || '').trim(),
    exitDescription: (parsed.exitDescription || '').trim(),
    headless,
  }
}

export function buildLoopCronPrompt(input: {
  objective: string
  exitDescription: string
  headless: boolean
}): string {
  let exit = input.exitDescription
  if (input.headless && !/无人值守|headless/i.test(exit)) {
    exit = `${exit}或无人值守`
  }
  return `loop: ${input.objective}；退出条件为${exit}`
}

export function suggestLoopScheduleName(objective: string): string {
  const slug = objective.replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, '').slice(0, 16) || 'loop'
  return `${slug}-${Date.now().toString(36).slice(-4)}`
}
