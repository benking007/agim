import { describe, expect, it } from 'vitest'
import {
  askCardsForThread,
  isAskUserActivityLabel,
  type PendingAskCardWire,
} from './pending-ask-cards'

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

describe('isAskUserActivityLabel', () => {
  it('matches native and MCP ask_user tool names', () => {
    expect(isAskUserActivityLabel('mcp__agim__ask_user')).toBe(true)
    expect(isAskUserActivityLabel('ask_user')).toBe(true)
    expect(isAskUserActivityLabel('plugin/ask_user')).toBe(true)
  })

  it('ignores unrelated tools', () => {
    expect(isAskUserActivityLabel('web_search')).toBe(false)
    expect(isAskUserActivityLabel('ask_followup')).toBe(false)
    expect(isAskUserActivityLabel('')).toBe(false)
    expect(isAskUserActivityLabel(undefined)).toBe(false)
  })
})
