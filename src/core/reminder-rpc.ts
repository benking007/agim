// reminder-rpc.ts — RPC handlers for agent-initiated reminder operations.
//
// Lives one layer below the MCP sidecar: the sidecar parses tool calls
// from the agent, sends them as `type:'reminder'` messages on the bus,
// and the bus delegates to handleReminderOp() here. Keeps approval-bus.ts
// focused on transport and lets reminder logic stay testable on its own.
//
// Why not just import this from sidecar directly?
// The sidecar runs as a separate Node process (spawned by claude-code via
// --mcp-config) and shouldn't touch reminders.db / sessionManager / the
// messenger registry — those are main-process state. The bus already has
// the runId → RunContext mapping (from approvalBus.registerRun), so it's
// the natural mediator.

import { logger as rootLogger } from './logger.js'
import {
  createReminder, listReminders, cancelReminder, snoozeReminder,
  parseDuration, isValidRecurrence,
  ReminderError, MIN_FUTURE_MS,
} from './reminders.js'
import { setPending } from './pending-reminder.js'
import type { RunContext } from './approval-bus.js'

const log = rootLogger.child({ component: 'reminder-rpc' })

/** Notifier responsible for delivering a confirmation card to the user
 *  when a high-frequency + LLM-polish reminder needs explicit y/n. The
 *  message body is fully composed by reminder-rpc; the notifier just
 *  routes it to the right messenger. Set once at startup from cli.ts. */
export type ReminderConfirmNotifier = (
  ctx: RunContext, message: string,
) => Promise<void>

let confirmNotifier: ReminderConfirmNotifier | null = null
export function setReminderConfirmNotifier(n: ReminderConfirmNotifier | null): void {
  confirmNotifier = n
}

export type ReminderOp = 'create' | 'list' | 'cancel' | 'snooze'

export type ReminderRpcResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

const HIGH_FREQ_THRESHOLD_MS = 60 * 60_000

export async function handleReminderOp(
  op: string,
  payload: Record<string, unknown>,
  ctx: RunContext,
): Promise<ReminderRpcResult> {
  try {
    switch (op) {
      case 'create': return await handleCreate(payload, ctx)
      case 'list': return handleList(ctx)
      case 'cancel': return handleCancel(payload, ctx)
      case 'snooze': return handleSnooze(payload, ctx)
      default: return { ok: false, error: `unknown op: ${op}` }
    }
  } catch (err) {
    if (err instanceof ReminderError) return { ok: false, error: err.message }
    log.warn({ event: 'rpc.unhandled', err: err instanceof Error ? err.message : String(err) })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── create ─────────────────────────────────────────────────────────

async function handleCreate(
  payload: Record<string, unknown>,
  ctx: RunContext,
): Promise<ReminderRpcResult> {
  const fireAtRaw = typeof payload.fireAt === 'string' ? payload.fireAt : null
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const recurrenceRaw = typeof payload.recurrence === 'string' ? payload.recurrence : null
  const promptModeRaw = typeof payload.promptMode === 'string' ? payload.promptMode : 'llm'
  const promptMode: 'literal' | 'llm' = promptModeRaw === 'literal' ? 'literal' : 'llm'

  if (!fireAtRaw) return { ok: false, error: 'fireAt is required (ISO 8601 local time)' }
  if (!text) return { ok: false, error: 'text is required' }
  const fireAt = new Date(fireAtRaw)
  if (Number.isNaN(fireAt.getTime())) {
    return { ok: false, error: `bad fireAt: "${fireAtRaw}"` }
  }
  if (recurrenceRaw && !isValidRecurrence(recurrenceRaw)) {
    return { ok: false, error: `bad recurrence: "${recurrenceRaw}"` }
  }

  const recurrence = recurrenceRaw ?? undefined

  // High-freq + LLM polish: stash a pending entry + send a confirmation
  // card to the user. Agent gets back a 'pending_confirmation' status and
  // should keep its reply terse — the card is the user-facing prompt.
  const isHighFreqLlm = promptMode === 'llm'
    && recurrence?.startsWith('every:')
    && (parseDuration(recurrence.slice(6)) ?? Number.POSITIVE_INFINITY) < HIGH_FREQ_THRESHOLD_MS

  if (isHighFreqLlm) {
    const tk = `${ctx.platform}:${ctx.channelId}:${ctx.threadId}`
    setPending(tk, {
      fireAt, text, recurrence,
    })
    const card = [
      '🔔 这是一条**高频循环 + LLM 润色**的提醒，需要你确认',
      `   内容：${text}`,
      `   循环：${recurrence}`,
      `   首次：${fireAt.toLocaleString()}`,
      '',
      '高频循环每次都会调一次 LLM 来润色，可能不是你想要的。',
      '回复 `y` 创建（含润色） / `n` 取消（或在创建时加 `literal` 关闭润色）',
    ].join('\n')
    if (confirmNotifier) {
      try { await confirmNotifier(ctx, card) } catch (err) {
        log.warn({ event: 'rpc.notifier_failed', err: err instanceof Error ? err.message : String(err) })
      }
    }
    return {
      ok: true,
      result: {
        status: 'pending_confirmation',
        message: 'High-frequency + LLM polish requires user confirmation. A card has been sent to the user — wait for them to reply y/n. You should keep your own reply brief.',
      },
    }
  }

  // Normal create
  const id = createReminder({
    fireAt, text,
    platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.threadId,
    userId: ctx.userId,
    source: 'mcp',
    recurrence,
    promptMode,
  })
  log.info({ event: 'rpc.create.ok', id, recurrence, promptMode, threadId: ctx.threadId })
  return {
    ok: true,
    result: {
      id,
      fireAt: fireAt.toISOString(),
      text,
      recurrence: recurrence ?? null,
      promptMode,
      message: `Reminder #${id} created. It will fire at ${fireAt.toLocaleString()}${recurrence ? ` and recur (${recurrence})` : ''}.`,
    },
  }
}

// ─── list ───────────────────────────────────────────────────────────

function handleList(ctx: RunContext): ReminderRpcResult {
  const owner = ctx.userId ? { creatorId: ctx.userId } : {}
  const all = listReminders({ ...owner, status: 'pending', limit: 50 })
  const slim = all.map((r) => ({
    id: r.id,
    fire_at: r.fire_at,
    text: r.text,
    recurrence: r.recurrence,
    prompt_mode: r.prompt_mode,
  }))
  return { ok: true, result: { reminders: slim } }
}

// ─── cancel ─────────────────────────────────────────────────────────

function handleCancel(payload: Record<string, unknown>, ctx: RunContext): ReminderRpcResult {
  const id = typeof payload.id === 'number' ? payload.id : Number.parseInt(String(payload.id), 10)
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'id must be a positive integer' }
  const owner = ctx.userId ? { creatorId: ctx.userId } : {}
  const ok = cancelReminder(id, owner)
  return ok
    ? { ok: true, result: { id, cancelled: true, message: `Reminder #${id} cancelled.` } }
    : { ok: false, error: `Reminder #${id} not found, not owned by you, or already terminal.` }
}

// ─── snooze ─────────────────────────────────────────────────────────

function handleSnooze(payload: Record<string, unknown>, ctx: RunContext): ReminderRpcResult {
  const id = typeof payload.id === 'number' ? payload.id : Number.parseInt(String(payload.id), 10)
  const duration = typeof payload.duration === 'string' ? payload.duration : ''
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'id must be a positive integer' }
  if (!duration) return { ok: false, error: 'duration is required (e.g. "5m", "30m", "2h")' }
  const deltaMs = parseDuration(duration)
  if (deltaMs === null) return { ok: false, error: `bad duration: "${duration}". Use s/m/h/d (e.g. 5m).` }
  if (deltaMs < MIN_FUTURE_MS) {
    return { ok: false, error: `duration too short (min ${MIN_FUTURE_MS / 1000}s)` }
  }
  const owner = ctx.userId ? { creatorId: ctx.userId } : {}
  try {
    const newId = snoozeReminder(id, deltaMs, owner)
    return {
      ok: true,
      result: { newId, originalId: id, duration, message: `Reminder #${id} snoozed by ${duration} → new #${newId}.` },
    }
  } catch (err) {
    if (err instanceof ReminderError) return { ok: false, error: err.message }
    throw err
  }
}
