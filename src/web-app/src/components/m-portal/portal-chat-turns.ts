import type { ChatMessage } from '@/hooks/use-chat'

/** One user turn + following assistant/system replies (until the next user). */
export interface ChatTurn {
  id: string
  user?: ChatMessage
  replies: ChatMessage[]
}

export function groupChatTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  let current: ChatTurn | null = null
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (current) turns.push(current)
      current = { id: msg.id, user: msg, replies: [] }
      continue
    }
    if (!current) {
      current = { id: `orphan-${msg.id}`, replies: [msg] }
    } else {
      current.replies.push(msg)
    }
  }
  if (current) turns.push(current)
  return turns
}
