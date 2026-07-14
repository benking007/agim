/**
 * Shared helpers for consecutive same-role bubble grouping.
 */

import type { ChatMessage } from '@/hooks/use-chat'

export function isSameBubbleGroup(a: ChatMessage | undefined, b: ChatMessage | undefined): boolean {
  if (!a || !b) return false
  if (a.approval || b.approval) return false
  if (a.role !== b.role) return false
  // Keep agent label changes as a new group for assistant replies.
  if (a.role === 'assistant' && (a.agent || '') !== (b.agent || '')) return false
  return true
}

export function bubbleGroupFlags(
  messages: ChatMessage[],
  index: number,
): { isFirstInGroup: boolean; isLastInGroup: boolean } {
  const cur = messages[index]
  const prev = messages[index - 1]
  const next = messages[index + 1]
  return {
    isFirstInGroup: !isSameBubbleGroup(prev, cur),
    isLastInGroup: !isSameBubbleGroup(cur, next),
  }
}
