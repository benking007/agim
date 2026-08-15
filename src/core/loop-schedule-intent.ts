// loop-schedule-intent.ts — NL "每天凌晨2点跑一轮 Loop" → confirmation card.
//
// Never silently creates a schedule. Flow:
//   1. Cheap pre-filter (recurring time + Loop-ish words) — no LLM.
//   2. Deterministic nlToCron + parseLoopStartText when the line is complete.
//   3. Optional helper LLM only when cron/mission slots are still missing.
//   4. Stash pending + ask y/n. Confirm calls createSchedule with `loop:`.

import { logger as rootLogger } from './logger.js'
import { callHelperForJson } from './agent-helper.js'
import { parseCron, nextOccurrence } from './cron.js'
import { createSchedule } from './schedule.js'
import { workspaceRegistry } from './workspace.js'
import { registry } from './registry.js'
import {
  setPendingLoopSchedule,
  tryConsumeLoopScheduleReply,
  type PendingLoopSchedule,
} from './pending-loop-schedule.js'
import {
  buildLoopCronPrompt,
  looksLikeScheduledLoopAsk,
  nlToCron,
  parseScheduledLoopMission,
  stripScheduleGlue,
  suggestLoopScheduleName,
} from './loop-schedule-nl.js'

const log = rootLogger.child({ component: 'loop-schedule-intent' })

const DETECTOR_TIMEOUT_MS = 10_000
const DETECTOR_MAX_OUTPUT = 700
const CONFIDENCE_THRESHOLD = 0.85

const DETECTOR_SYSTEM_PROMPT = [
  '你是「定时 Loop」意图识别器，不是提醒识别器。',
  '用户想用 cron 周期启动 Agim Loop（目标+退出条件，派子代理验收），不是设一个到点推送的提醒。',
  '',
  '只输出一个 JSON 对象（不要 markdown 围栏）：',
  '{',
  '  "is_scheduled_loop": boolean,',
  '  "confidence": number,',
  '  "cron": string|null,              // 5 段 POSIX：min hour dom mon dow',
  '  "cron_label": string|null,        // 给人看的时间，如 "每天 02:00"',
  '  "objective": string|null,',
  '  "exit_description": string|null,  // 必须是用户说的退出条件，禁止臆造',
  '  "headless": boolean',
  '}',
  '',
  'is_scheduled_loop=true 仅当：周期时间 + 要跑 Loop/闭环/使命验收。',
  '反例（必须 false）："每天8点提醒我吃药"（提醒）、"帮我开个 loop 修登录"（当场 /loop，无周期）、闲聊。',
  'exit_description 用户没说就 null，不要默认「最多12轮」。',
  'headless=true 当用户说无人值守 / headless。',
  'cron 例子：每天凌晨2点 → "0 2 * * *"；每个工作日9:30 → "30 9 * * 1-5"。',
].join('\n')

interface DetectorResult {
  is_scheduled_loop?: boolean
  confidence?: number
  cron?: string | null
  cron_label?: string | null
  objective?: string | null
  exit_description?: string | null
  headless?: boolean
}

export interface LoopScheduleTurnResult {
  handled: boolean
  reply?: string
}

const NOT_HANDLED: LoopScheduleTurnResult = { handled: false }

function threadKeyOf(platform: string, channelId: string, threadId: string): string {
  return `${platform}:${channelId}:${threadId}`
}

function formatCard(p: Omit<PendingLoopSchedule, 'createdAt'>): string {
  const headlessLine = p.headless ? '\n   无人值守：是（达标后自动结案）' : ''
  return [
    '🔁 要不要创建这条**定时 Loop**？',
    `   时间：${p.cronLabel}（\`${p.cron}\`）`,
    `   目标：${p.objective}`,
    `   退出：${p.exitDescription}${headlessLine}`,
    '',
    '到点会在专用 cron 线程上 start / 续跑一轮（不抢你当前对话的 Focus）。',
    '回复 `y` 创建 / `n` 不用（5 分钟没回复自动忽略）',
  ].join('\n')
}

function validateCron(expr: string): { cron: string; next: Date } | null {
  try {
    const spec = parseCron(expr)
    const next = nextOccurrence(spec, new Date())
    if (!next) return null
    return { cron: expr.trim(), next }
  } catch {
    return null
  }
}

function propose(
  threadKey: string,
  slots: {
    cron: string
    cronLabel: string
    objective: string
    exitDescription: string
    headless: boolean
  },
): LoopScheduleTurnResult {
  const pending = {
    name: suggestLoopScheduleName(slots.objective),
    cron: slots.cron,
    cronLabel: slots.cronLabel,
    objective: slots.objective.slice(0, 200),
    exitDescription: slots.exitDescription.slice(0, 200),
    headless: slots.headless,
  }
  setPendingLoopSchedule(threadKey, pending)
  log.info({
    event: 'loop-schedule-intent.proposed',
    threadKey,
    cron: pending.cron,
    objective: pending.objective,
  })
  return { handled: true, reply: formatCard(pending) }
}

function incompleteHint(kind: 'exit' | 'cron' | 'objective'): string {
  if (kind === 'cron') {
    return [
      '听起来你想定时开一个 Loop，但没看懂时间。',
      '请写成例如：`每天凌晨2点` / `每个工作日 9:30` / `每周一三五 20:00`。',
    ].join('\n')
  }
  if (kind === 'objective') {
    return '听起来你想定时开一个 Loop，但还缺目标。请补上要做什么。'
  }
  return [
    '听起来你想定时开一个 Loop，但还缺**退出条件**（硬字段，不能默认）。',
    '请补一句后再说，例如：`退出条件为验收通过或最多5轮`。',
  ].join('\n')
}

async function llmFill(opts: {
  platform: string
  channelId: string
  threadId: string
  text: string
  now: Date
}): Promise<DetectorResult | null> {
  return callHelperForJson<DetectorResult>({
    platform: opts.platform,
    channelId: opts.channelId,
    threadId: opts.threadId,
    systemPrompt: DETECTOR_SYSTEM_PROMPT,
    userPrompt: [
      `当前时间：${opts.now.toLocaleString()}`,
      `用户消息：${opts.text}`,
    ].join('\n'),
    timeoutMs: DETECTOR_TIMEOUT_MS,
    maxOutputChars: DETECTOR_MAX_OUTPUT,
  })
}

/**
 * Detect a scheduled-Loop ask and return a confirmation card.
 * Incomplete Loop-ish lines are still `handled` (hint, no pending) so the
 * reminder detector does not steal them.
 */
export async function tryDetectScheduledLoopIntent(opts: {
  platform: string
  channelId: string
  threadId: string
  userId: string
  text: string
  now?: Date
}): Promise<LoopScheduleTurnResult> {
  const trimmed = (opts.text || '').trim()
  if (!looksLikeScheduledLoopAsk(trimmed)) return NOT_HANDLED

  const threadKey = threadKeyOf(opts.platform, opts.channelId, opts.threadId)
  const parsedCron = nlToCron(trimmed)
  const mission = parseScheduledLoopMission(stripScheduleGlue(trimmed, parsedCron?.matched))

  if (parsedCron && mission.objective && mission.exitDescription) {
    const ok = validateCron(parsedCron.cron)
    if (ok) {
      return propose(threadKey, {
        cron: parsedCron.cron,
        cronLabel: parsedCron.label,
        objective: mission.objective,
        exitDescription: mission.exitDescription,
        headless: mission.headless,
      })
    }
  }

  // Deterministic clock + goal but no exit: do not spend an LLM turn,
  // and do not fall through to the reminder detector.
  if (parsedCron && mission.objective && !mission.exitDescription) {
    return { handled: true, reply: incompleteHint('exit') }
  }

  const det = await llmFill({
    platform: opts.platform,
    channelId: opts.channelId,
    threadId: opts.threadId,
    text: trimmed,
    now: opts.now ?? new Date(),
  })

  if (det?.is_scheduled_loop && (det.confidence ?? 0) >= CONFIDENCE_THRESHOLD) {
    const cronExpr = (det.cron || parsedCron?.cron || '').trim()
    const ok = cronExpr ? validateCron(cronExpr) : null
    const objective = (det.objective || mission.objective || '').trim()
    const exitDescription = (det.exit_description || mission.exitDescription || '').trim()
    const headless = det.headless === true || mission.headless
    if (!ok) return { handled: true, reply: incompleteHint('cron') }
    if (!objective) return { handled: true, reply: incompleteHint('objective') }
    if (!exitDescription) return { handled: true, reply: incompleteHint('exit') }
    return propose(threadKey, {
      cron: ok.cron,
      cronLabel: (det.cron_label || parsedCron?.label || ok.cron).trim(),
      objective,
      exitDescription,
      headless,
    })
  }

  if (looksLikeScheduledLoopAsk(trimmed) && !parsedCron) {
    return { handled: true, reply: incompleteHint('cron') }
  }
  return NOT_HANDLED
}

export function commitPendingLoopSchedule(input: {
  pending: PendingLoopSchedule
  userId: string
}): { ok: true; id: number; nextIso: string } | { ok: false; error: string } {
  const agim = registry.findAgent('agim')
  if (!agim) return { ok: false, error: 'Agim Agent 未注册，无法作为 Loop 父编排' }
  const ws = workspaceRegistry.resolve(input.userId || 'unknown')
  if (!ws.hasAgent(agim.name)) {
    return { ok: false, error: `Agim Agent 不在 workspace "${ws.name}" 白名单内` }
  }
  const prompt = buildLoopCronPrompt(input.pending)
  try {
    const id = createSchedule({
      name: input.pending.name,
      agent: agim.name,
      cron: input.pending.cron,
      prompt,
      creatorId: input.userId || '',
      workspaceId: ws.id,
    })
    const next = nextOccurrence(parseCron(input.pending.cron))
    return { ok: true, id, nextIso: next?.toISOString() || '' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Consume y/n or run detection. Used by IM + Web inbound. */
export async function tryHandleScheduledLoopTurn(opts: {
  platform: string
  channelId: string
  threadId: string
  userId: string
  text: string
  now?: Date
}): Promise<LoopScheduleTurnResult> {
  const threadKey = threadKeyOf(opts.platform, opts.channelId, opts.threadId)
  const decision = tryConsumeLoopScheduleReply(threadKey, opts.text)
  if (decision) {
    if (decision.decision === 'cancel') {
      return { handled: true, reply: '✅ 已忽略这条定时 Loop 建议' }
    }
    const created = commitPendingLoopSchedule({
      pending: decision.pending,
      userId: opts.userId,
    })
    if (!created.ok) return { handled: true, reply: `❌ 创建失败：${created.error}` }
    return {
      handled: true,
      reply: [
        `✅ 已创建定时 Loop #${created.id}`,
        `   时间：${decision.pending.cronLabel}（\`${decision.pending.cron}\`）`,
        `   目标：${decision.pending.objective}`,
        `   退出：${decision.pending.exitDescription}`,
        created.nextIso ? `   下次：${created.nextIso}` : '',
        '',
        '列表：`/cron list`　停用：`/cron disable <id>`',
      ].filter(Boolean).join('\n'),
    }
  }

  if (opts.text.trim().startsWith('/')) return NOT_HANDLED
  return tryDetectScheduledLoopIntent(opts)
}
