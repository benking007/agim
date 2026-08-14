// Mid-turn user supplements (Portal "pending send" → Agim absorb).
//
// AgentHarness already has steer() — inject a durable user message after the
// current tool batch and before the next provider hop. This module is the
// process-wide mailbox so a WebSocket `steer` frame can reach the live
// harness without waiting behind the serial inbound queue.
//
// Keyed by the same thread key as approvals (`platform:channelId:threadId`).
// Tests / A2A without a platform fall back to `agim:<sessionId>`.

import { randomBytes } from 'node:crypto'

export interface TurnSteerItem {
  id: string
  text: string
  at: number
}

type LiveSteerFn = (text: string) => Promise<void>

const pending = new Map<string, TurnSteerItem[]>()
const live = new Map<string, LiveSteerFn>()

export function threadSteerKey(platform: string, channelId: string, threadId: string): string {
  return `${platform}:${channelId}:${threadId}`
}

export function formatMidTurnSteer(text: string): string {
  const body = text.trim()
  return [
    '【本轮补充】用户在本轮工作中补充了说明。请先认真读完，当作当前任务的重要约束，继续本轮；若与已有方案冲突或需要细化，再调整后再继续。',
    '',
    body,
  ].join('\n')
}

export function enqueueTurnSteer(key: string, text: string): TurnSteerItem {
  const item: TurnSteerItem = {
    id: `steer-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    text: text.trim(),
    at: Date.now(),
  }
  const list = pending.get(key) ?? []
  list.push(item)
  pending.set(key, list)
  return item
}

export function peekTurnSteers(key: string): TurnSteerItem[] {
  return [...(pending.get(key) ?? [])]
}

export function consumeTurnSteers(key: string): TurnSteerItem[] {
  const list = pending.get(key) ?? []
  pending.delete(key)
  return list
}

/** Register the live harness.steer wrapper. Drains any queued items. */
export function registerLiveSteer(key: string, fn: LiveSteerFn): () => void {
  live.set(key, fn)
  const queued = consumeTurnSteers(key)
  void (async () => {
    for (const item of queued) {
      if (live.get(key) !== fn) {
        enqueueTurnSteer(key, item.text)
        return
      }
      try {
        await fn(item.text)
      } catch {
        enqueueTurnSteer(key, item.text)
      }
    }
  })()
  return () => {
    if (live.get(key) === fn) live.delete(key)
  }
}

export function hasLiveSteer(key: string): boolean {
  return live.has(key)
}

/** Push into the live harness, or park until one registers. */
export async function dispatchTurnSteer(key: string, text: string): Promise<'live' | 'queued'> {
  const trimmed = text.trim()
  if (!trimmed) return 'queued'
  const fn = live.get(key)
  if (fn) {
    try {
      await fn(trimmed)
      return 'live'
    } catch {
      enqueueTurnSteer(key, trimmed)
      return 'queued'
    }
  }
  enqueueTurnSteer(key, trimmed)
  return 'queued'
}

/** Test-only. */
export function _resetTurnSteer(): void {
  pending.clear()
  live.clear()
}
