// remind-intent.ts — LLM intent detector for non-slash messages.
//
// When a user types something like "明天早上8点提醒我开会" without `/remind`,
// this module asks the active agent to classify the message. If it looks
// like a reminder request with high confidence, we stash a pending entry
// and reply with a confirmation card — the user clicks y/n, never gets
// silently auto-created.
//
// Cost guard: we run a cheap regex pre-filter first (must contain a
// time-like token). Only messages that pass the pre-filter ever reach the
// LLM. This avoids burning agent calls on every chat message.

import { logger as rootLogger } from './logger.js'
import { callHelperForJson } from './agent-helper.js'
import { isAiwatchEnabled } from './reminders.js'
import { setPending } from './pending-reminder.js'
import { isValidRecurrence } from './reminders.js'

const log = rootLogger.child({ component: 'remind-intent' })

const DETECTOR_TIMEOUT_MS = 10_000
const DETECTOR_MAX_OUTPUT = 600
// Tightened from 0.7 to 0.85 once the agent-MCP fallback path landed:
// B-tier (implicit reminders, e.g. "对了，明天有聚餐") usually score
// 0.65~0.85 — those now fall through to the agent which has full
// conversation context. F1 only fires for clear A-tier explicit asks
// ("提醒我..."、"叫我..."、"X 分钟后...") which score ≥ 0.85.
const CONFIDENCE_THRESHOLD = 0.85

// Pre-filter: any time-ish token. Catches CN units (秒/分/时/天/周/月/点),
// CN time words (早上/上午/中午/下午/晚上/凌晨/今晚/明天/后天/每天/每周),
// EN durations (Nm/Nh/Nd, "every N…"), HH:MM, ISO date.
//
// Goal: high recall, false positives are cheap (an extra LLM call).
// Real misses are expensive (silent feature failure for natural phrasings).
const TIME_HINT_RE = new RegExp([
  '\\d+\\s*(秒|分钟|分|小时|钟头|时|天|周|月|点|刻)',
  '(早上|上午|中午|下午|晚上|凌晨|今晚|今天|明天|后天|今早|大后天)',
  '(每天|每日|每周|每月|每年|每个工作日|每隔)',
  '\\d{1,2}:\\d{2}',
  '\\d{4}-\\d{2}-\\d{2}',
  '\\b(every\\s+\\d|in\\s+\\d+\\s*(min|hour|day|sec))\\b',
  '(提醒|通知|叫我|喊我|告诉我|记得|别忘了|提醒我)',
].join('|'), 'i')

const DETECTOR_SYSTEM_PROMPT = [
  '你是一个"未来事件 / 提醒意图"识别器。',
  '任务：判断用户消息是否提到了一件具体的、未来发生的、用户参与的事件，',
  '且为这件事提前提醒一下是合理的。',
  '',
  '严格只输出一个 JSON 对象（不要 markdown 围栏，不要解释），schema:',
  '{',
  '  "is_reminder": boolean,',
  '  "confidence": number,        // 0.0~1.0',
  '  "fire_at_iso": string|null,  // ISO 8601 本地时间，如 "2026-05-09T20:30:00"',
  '  "text": string|null,         // 要做的事，≤ 60 字',
  '  "recurrence": string|null    // every:5m / daily:HH:MM / weekly:1,3,5:HH:MM，无则 null',
  '}',
  '',
  '识别分级（仍输出 is_reminder + confidence）：',
  '',
  'A. 显式请求 (confidence 0.85~0.99)：用户直接要求设提醒。',
  '   例: "提醒我明天9点开会"、"30分钟后叫我喝水"、"每天8点提醒我吃药"',
  '',
  'B. 隐式备忘 (confidence 0.65~0.85)：用户陈述未来事件 + 自己参与，',
  '   语气暗示"别忘了/在意这件事"——日常生活中"顺嘴说一下" 的备忘。',
  '   例（都判 is_reminder=true）:',
  '   - "对了，明天中午我和团队有个聚餐"',
  '   - "明天9点要开会"',
  '   - "下午要给爸打电话"',
  '   - "周五晚上7点演唱会"',
  '   - "记一下，下周三去医院复查"',
  '',
  'C. 必须 is_reminder=false 的反例：',
  '   - 描述过去："昨天开会很累"、"刚才提醒过了"',
  '   - 假设/问句："明天会下雨吗"、"如果迟到了怎么办"',
  '   - 抽象讨论：天气、新闻、技术问题、闲聊',
  '   - 模糊时间 + 无具体事件："过段时间再说"、"以后再聊"',
  '   - 别人的事："小王明天去开会"（不是用户参与的）',
  '',
  '其他规则：',
  '- 时间必须未来 + 具体（精确到日 + 大致时段：早上/中午/下午/晚上）。',
  '- "明天中午" → 大约 12:00；"早上" → 09:00；"下午" → 15:00；"晚上" → 20:00。具体时点优先（"明天9点" → 09:00:00）。',
  '- text 是事，不是时间。"明天9点开会" 的 text 是 "开会"，不是 "明天9点开会"。',
  '- fire_at_iso 用本地时区，格式 "YYYY-MM-DDTHH:MM:SS"，不带 Z 也不带偏移。',
  '- 不确定就给较低 confidence，让阈值机制兜底。',
].join('\n')

interface DetectorResult {
  is_reminder: boolean
  confidence?: number
  fire_at_iso?: string | null
  text?: string | null
  recurrence?: string | null
}

export interface DetectionOutcome {
  /** True when we want to short-circuit the normal agent flow. */
  handled: boolean
  /** Reply text to send the user (the confirmation card). */
  reply?: string
}

const NON_HANDLED: DetectionOutcome = { handled: false }

/**
 * Run the detector against an inbound message. On positive detection,
 * stashes a pending entry under the thread key and returns a confirmation
 * card text. On any negative outcome (filter miss, LLM null, low
 * confidence, time validation fails) returns { handled: false } so the
 * caller dispatches the message normally.
 *
 * Owner-scoped: respects the per-user `aiwatch` setting. Off → skip.
 */
export async function tryDetectReminderIntent(opts: {
  platform: string
  channelId: string
  threadId: string
  userId: string
  text: string
  /** Test hook for time-injection. Default: new Date(). */
  now?: Date
}): Promise<DetectionOutcome> {
  const { platform, channelId, threadId, userId, text } = opts
  const now = opts.now ?? new Date()

  // 1. User opt-out
  if (userId && !isAiwatchEnabled(platform, userId)) {
    return NON_HANDLED
  }
  // 2. Skip slash + obvious non-content
  const trimmed = text.trim()
  if (!trimmed || trimmed.length < 3 || trimmed.length > 500) return NON_HANDLED
  if (trimmed.startsWith('/')) return NON_HANDLED
  // 3. Cheap regex pre-filter — if no time-ish token, skip LLM entirely
  if (!TIME_HINT_RE.test(trimmed)) return NON_HANDLED

  // 4. LLM extraction
  const userPrompt = [
    `当前时间：${now.toLocaleString()}`,
    `当前时间（ISO）：${formatLocalIso(now)}`,
    `用户消息：${trimmed}`,
  ].join('\n')

  const det = await callHelperForJson<DetectorResult>({
    platform, channelId, threadId,
    systemPrompt: DETECTOR_SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: DETECTOR_TIMEOUT_MS,
    maxOutputChars: DETECTOR_MAX_OUTPUT,
  })

  if (!det || !det.is_reminder) {
    log.debug({ event: 'remind-intent.skip', reason: det ? 'is_reminder=false' : 'llm_null' })
    return NON_HANDLED
  }
  const conf = typeof det.confidence === 'number' ? det.confidence : 0
  if (conf < CONFIDENCE_THRESHOLD) {
    log.debug({ event: 'remind-intent.low_conf', conf })
    return NON_HANDLED
  }

  // 5. Validate extracted slots
  if (!det.fire_at_iso || !det.text) {
    log.debug({ event: 'remind-intent.bad_slots', det })
    return NON_HANDLED
  }
  const fireAt = new Date(det.fire_at_iso)
  if (Number.isNaN(fireAt.getTime())) {
    log.debug({ event: 'remind-intent.bad_iso', iso: det.fire_at_iso })
    return NON_HANDLED
  }
  const deltaMs = fireAt.getTime() - now.getTime()
  if (deltaMs < 10_000 || deltaMs > 7 * 24 * 60 * 60_000) {
    log.debug({ event: 'remind-intent.out_of_range', deltaMs })
    return NON_HANDLED
  }
  let recurrence: string | undefined
  if (det.recurrence) {
    if (isValidRecurrence(det.recurrence)) {
      recurrence = det.recurrence
    } else {
      log.debug({ event: 'remind-intent.bad_recurrence', rec: det.recurrence })
      // Not fatal: drop recurrence, keep one-shot
    }
  }

  // 6. Stash pending + return confirmation card
  const threadKey = `${platform}:${channelId}:${threadId}`
  const cleanText = String(det.text).slice(0, 200)
  setPending(threadKey, {
    fireAt,
    text: cleanText,
    recurrence,
  })

  const recurLine = recurrence ? `\n   循环：${recurrence}` : ''
  const reply = [
    '🔔 要不要为这件事设个提醒？',
    `   内容：${cleanText}`,
    `   时间：${fireAt.toLocaleString()}${recurLine}`,
    '',
    '回复 `y` 创建 / `n` 不用（5 分钟没回复自动忽略）',
  ].join('\n')

  log.info({
    event: 'remind-intent.proposed',
    threadKey, text: cleanText, fireAt: fireAt.toISOString(), conf, recurrence,
  })
  return { handled: true, reply }
}

/** Format a Date as a local-time ISO-ish string ("2026-05-09T20:30:00").
 *  Note: this is the same shape as Reminder.fire_at storage. */
function formatLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
