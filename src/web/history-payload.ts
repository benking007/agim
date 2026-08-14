/**
 * history-payload.ts — shrink + window the WebSocket `history` frame.
 *
 * Agent prompts still read the full on-disk `.log`. This module only shapes
 * what the SPA receives so a large transcript does not stall first paint:
 *   1. Cap `activity.steps[].preview` (tool dumps dwarf the reply).
 *   2. Send the newest messages first (count + byte budget).
 *   3. Follow with `history-prepend` chunks of older turns.
 */

import type { ChatMessage, PersistedChatActivity } from '../core/types.js'

/** Tool-step previews in history / active-run replay. Disk `.log` is unchanged. */
export const HISTORY_PREVIEW_MAX_CHARS = 500

/** Prefer at most this many messages in the first `history` frame. */
export const HISTORY_TAIL_MAX_MESSAGES = 40

/**
 * Soft cap on estimated UTF-16 units in the first frame. One huge latest
 * reply still goes out in full (the user is looking at it); older bulky
 * turns wait for prepend chunks.
 */
export const HISTORY_TAIL_MAX_BYTES = 256 * 1024

/** Older messages per `history-prepend` frame (nearest-to-tail first). */
export const HISTORY_PREPEND_CHUNK = 40

/** Always keep at least this many newest messages in the tail (one turn). */
const HISTORY_TAIL_MIN_MESSAGES = 2

export function capHistoryPreview(preview: string | undefined): string | undefined {
  if (preview == null || preview.length <= HISTORY_PREVIEW_MAX_CHARS) return preview
  return `${preview.slice(0, HISTORY_PREVIEW_MAX_CHARS)}…`
}

export function slimActivitySteps<T extends { preview?: string }>(steps: T[]): T[] {
  let changed = false
  const next = steps.map((st) => {
    const preview = capHistoryPreview(st.preview)
    if (preview === st.preview) return st
    changed = true
    return { ...st, preview }
  })
  return changed ? next : steps
}

export function slimHistoryMessage(message: ChatMessage): ChatMessage {
  const activity = message.activity
  if (!activity?.steps?.length) return message
  const steps = slimActivitySteps(activity.steps)
  if (steps === activity.steps) return message
  const nextActivity: PersistedChatActivity = { ...activity, steps }
  return { ...message, activity: nextActivity }
}

export function slimHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(slimHistoryMessage)
}

export function estimateHistoryMessageBytes(message: ChatMessage): number {
  let n = (message.content?.length ?? 0) + 80
  const steps = message.activity?.steps
  if (!steps) return n
  for (const st of steps) {
    n += (st.preview?.length ?? 0) + (st.label?.length ?? 0) + 64
  }
  return n
}

/** Index where the first-paint tail begins (0 = send everything). */
export function historyTailStart(messages: ChatMessage[]): number {
  const len = messages.length
  if (len === 0) return 0
  let bytes = 0
  let count = 0
  for (let i = len - 1; i >= 0; i--) {
    const row = messages[i]
    if (!row) continue
    const sz = estimateHistoryMessageBytes(row)
    if (
      count >= HISTORY_TAIL_MIN_MESSAGES
      && (count >= HISTORY_TAIL_MAX_MESSAGES || bytes + sz > HISTORY_TAIL_MAX_BYTES)
    ) {
      return i + 1
    }
    bytes += sz
    count++
  }
  return 0
}

export interface HistoryPrependChunk {
  messages: ChatMessage[]
  startIndex: number
  remaining: number
}

export interface HistoryDelivery {
  tail: ChatMessage[]
  tailStart: number
  olderCount: number
  prepend: HistoryPrependChunk[]
}

/**
 * Slim previews, then split into a first-paint tail + prepend chunks.
 * Chunks are ordered nearest-to-tail first so each prepend attaches
 * without leaving a gap in the SPA transcript.
 */
export function splitHistoryDelivery(messages: ChatMessage[]): HistoryDelivery {
  const slimmed = slimHistoryMessages(messages)
  const tailStart = historyTailStart(slimmed)
  const tail = slimmed.slice(tailStart)
  const older = slimmed.slice(0, tailStart)
  const prepend: HistoryPrependChunk[] = []
  for (let end = older.length; end > 0; end -= HISTORY_PREPEND_CHUNK) {
    const startIndex = Math.max(0, end - HISTORY_PREPEND_CHUNK)
    prepend.push({
      messages: older.slice(startIndex, end),
      startIndex,
      remaining: startIndex,
    })
  }
  return { tail, tailStart, olderCount: older.length, prepend }
}

/** First non-empty user line in the full log — session rail title. */
export function historySessionTitle(messages: ChatMessage[]): string | undefined {
  const user = messages.find((m) => m.role === 'user' && m.content.trim())
  if (!user) return undefined
  const text = user.content.trim().replace(/\s+/g, ' ')
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

function toEpochMs(value: Date | number | string | undefined): number {
  if (value instanceof Date) {
    const n = value.getTime()
    return Number.isFinite(n) ? n : 0
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Date.parse(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/**
 * Cloud transcript revision for the SPA rail + cache stamp.
 *
 * Prefer the newest message timestamp when the transcript has turns —
 * `lastActivity` is also bumped by metadata patches (set-workspace) and
 * getOrCreate touches, which must not rewrite the rail age to "Just now"
 * when the user merely switches sessions.
 *
 * Empty threads still fall back to lastActivity.
 */
export function historyUpdatedAt(input: {
  lastActivity?: Date | number | string
  messages: Array<{ timestamp?: Date | number | string }>
}): number {
  let msgMax = 0
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const ms = toEpochMs(input.messages[i]?.timestamp)
    if (ms > msgMax) msgMax = ms
  }
  if (msgMax > 0) return msgMax
  return toEpochMs(input.lastActivity)
}

export function buildHistoryWireFrames(
  messages: ChatMessage[],
  meta: Record<string, unknown>,
  decorate: (m: ChatMessage, absIndex: number) => Record<string, unknown>,
): Array<Record<string, unknown>> {
  const delivery = splitHistoryDelivery(messages)
  const threadId = typeof meta.threadId === 'string' && meta.threadId
    ? { threadId: meta.threadId }
    : {}
  const frames: Array<Record<string, unknown>> = [{
    type: 'history',
    messages: delivery.tail.map((m, i) => decorate(m, delivery.tailStart + i)),
    olderCount: delivery.olderCount,
    historyComplete: delivery.olderCount === 0,
    sessionTitle: historySessionTitle(messages) || '',
    ...meta,
  }]
  for (const chunk of delivery.prepend) {
    frames.push({
      type: 'history-prepend',
      messages: chunk.messages.map((m, i) => decorate(m, chunk.startIndex + i)),
      remaining: chunk.remaining,
      ...threadId,
    })
  }
  return frames
}
