import { describe, expect, it } from 'vitest'
import { askCardsForThread, type PendingAskCardWire } from './pending-ask-cards'

function card(over: Partial<PendingAskCardWire> = {}): PendingAskCardWire {
  return {
    reqId: 'r1',
    platform: 'web',
    threadId: 'web-aaa',
    messageId: 'ask-1',
    prompt: {
      body: '按此实施？',
      choices: [{ label: '1. 按此方案实施', data: 'ask:r1:1' }],
    },
    ...over,
  }
}

describe('askCardsForThread', () => {
  it('keeps only this web thread', () => {
    const cards = [
      card({ threadId: 'web-aaa', messageId: 'a' }),
      card({ threadId: 'web-bbb', messageId: 'b' }),
      card({ threadId: 'web-aaa', platform: 'telegram', messageId: 'c' }),
    ]
    expect(askCardsForThread(cards, 'web-aaa').map((c) => c.messageId)).toEqual(['a'])
  })

  it('returns empty for missing thread or list', () => {
    expect(askCardsForThread(undefined, 'web-aaa')).toEqual([])
    expect(askCardsForThread([card()], '')).toEqual([])
  })
})
