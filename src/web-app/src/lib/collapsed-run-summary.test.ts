import { describe, expect, it } from 'vitest'
import type { ChatActivity } from '@/hooks/use-chat'
import {
  clipActivitySnippet,
  formatCollapsedRunSummary,
  shortActivityToolLabel,
} from './collapsed-run-summary'

function activity(over: Partial<ChatActivity> = {}): ChatActivity {
  return {
    runId: 'run-1',
    status: 'running',
    startedAt: 1,
    steps: [],
    ...over,
  }
}

describe('collapsed-run-summary', () => {
  it('shortens vendor-prefixed tool names', () => {
    expect(shortActivityToolLabel('mcp__agim__read_skill')).toBe('read_skill')
    expect(shortActivityToolLabel('agim_exec')).toBe('exec')
    expect(shortActivityToolLabel('agim_web_search')).toBe('web_search')
  })

  it('clips long thinking to a one-line budget', () => {
    const long = '先确认 MINIMAX 的港股代码再拉行情并核对上市日'
    expect(clipActivitySnippet(long, 22).endsWith('…')).toBe(true)
    expect(clipActivitySnippet(long, 22).length).toBeLessThanOrEqual(22)
  })

  it('joins latest think + latest tool and stays short', () => {
    expect(formatCollapsedRunSummary(activity())).toBe('')
    const line = formatCollapsedRunSummary(activity({
      steps: [
        {
          id: 'r1',
          kind: 'reflect',
          label: '先确认 MINIMAX 的港股代码再拉行情',
          status: 'success',
          startedAt: 1,
        },
        {
          id: 't1',
          kind: 'tool',
          label: 'agim_web_search',
          status: 'running',
          startedAt: 2,
        },
      ],
    }))
    expect(line).toContain('web_search')
    expect(line).toContain('先确认')
    expect(line.length).toBeLessThanOrEqual(42)
  })
})
