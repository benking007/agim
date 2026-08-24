/**
 * HTTP catch-up for ask_user cards. choice-card is WS-only and is lost
 * on a half-open socket (OPEN + isAlive still true) — GET /api/asks/pending
 * is the path that does not depend on that pipe.
 */

import type { ChoiceCardPrompt } from '@/types/ws'

export interface PendingAskCardWire {
  reqId: string
  platform: string
  threadId: string
  messageId: string
  prompt: ChoiceCardPrompt
}

export function askCardsForThread(
  cards: PendingAskCardWire[] | undefined,
  threadId: string,
): PendingAskCardWire[] {
  if (!cards?.length || !threadId) return []
  return cards.filter((c) => c.threadId === threadId && (c.platform === 'web' || !c.platform))
}
