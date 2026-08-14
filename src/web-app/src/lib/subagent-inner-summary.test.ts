import { describe, expect, it } from 'vitest'
import {
  clipInnerSnippet,
  formatSubagentInnerSummary,
  shortInnerToolLabel,
} from './subagent-inner-summary'

describe('shortInnerToolLabel', () => {
  it('strips mcp / agim prefixes', () => {
    expect(shortInnerToolLabel('mcp__agim__web_search')).toBe('web_search')
    expect(shortInnerToolLabel('agim_exec')).toBe('exec')
  })
})

describe('formatSubagentInnerSummary', () => {
  it('joins latest think and tool', () => {
    expect(formatSubagentInnerSummary({
      reflects: [{ next: 'Fetch filings' }],
      lastTool: { label: 'agim_web_search' },
    })).toBe('Fetch filings · web_search')
  })

  it('shows a tool alone so the card is not stuck on Thinking…', () => {
    expect(formatSubagentInnerSummary({
      lastTool: { label: 'mcp__agim__web_fetch' },
    })).toBe('web_fetch')
  })

  it('returns empty when nothing has arrived', () => {
    expect(formatSubagentInnerSummary({})).toBe('')
    expect(clipInnerSnippet('   ', 8)).toBe('')
  })
})
