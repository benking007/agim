import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/hooks/use-chat'
import { bubbleGroupFlags, isSameBubbleGroup } from './bubble-group'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage {
  return {
    content: '',
    timestamp: Date.now(),
    ...partial,
  }
}

describe('bubble-group', () => {
  it('groups consecutive same-role messages', () => {
    const a = msg({ id: '1', role: 'user' })
    const b = msg({ id: '2', role: 'user' })
    const c = msg({ id: '3', role: 'assistant', agent: 'agim' })
    expect(isSameBubbleGroup(a, b)).toBe(true)
    expect(isSameBubbleGroup(b, c)).toBe(false)
  })

  it('splits assistant groups when agent changes', () => {
    const a = msg({ id: '1', role: 'assistant', agent: 'agim' })
    const b = msg({ id: '2', role: 'assistant', agent: 'claude-code' })
    expect(isSameBubbleGroup(a, b)).toBe(false)
  })

  it('exposes first/last flags for a run', () => {
    const messages = [
      msg({ id: '1', role: 'user' }),
      msg({ id: '2', role: 'user' }),
      msg({ id: '3', role: 'assistant', agent: 'agim' }),
    ]
    expect(bubbleGroupFlags(messages, 0)).toEqual({ isFirstInGroup: true, isLastInGroup: false })
    expect(bubbleGroupFlags(messages, 1)).toEqual({ isFirstInGroup: false, isLastInGroup: true })
    expect(bubbleGroupFlags(messages, 2)).toEqual({ isFirstInGroup: true, isLastInGroup: true })
  })
})
