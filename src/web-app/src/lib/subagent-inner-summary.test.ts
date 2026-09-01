import { describe, expect, it } from 'vitest'
import {
  clipInnerSnippet,
  formatSubagentHeartbeatLine,
  formatSubagentInnerSummary,
  inferSubagentPhase,
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

describe('formatSubagentHeartbeatLine', () => {
  it('shows phase, callee, last tool, and wait', () => {
    expect(inferSubagentPhase({ status: 'running', label: 'agim_exec' })).toBe('tool')
    expect(formatSubagentHeartbeatLine({
      zh: true,
      label: 'cursor',
      lastTool: { label: 'agim_exec', status: 'running', at: 10_000 },
      startedAt: 1_000,
      now: 241_000,
    })).toBe('执行工具 · cursor · exec · 已等 4m 0s · 上次工具 3m 51s')
  })

  it('falls back to pulse age when no child tool has arrived', () => {
    expect(formatSubagentHeartbeatLine({
      zh: true,
      label: 'cursor',
      startedAt: 1_000,
      heartbeatAt: 230_000,
      now: 241_000,
    })).toBe('运行中 · cursor · 已等 4m 0s · 心跳 11s')
  })
})
