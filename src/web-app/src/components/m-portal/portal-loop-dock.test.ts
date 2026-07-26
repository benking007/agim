import { describe, expect, it } from 'vitest'

import { buildLoopReportPrompt } from './portal-loop-report-prompt'

describe('buildLoopReportPrompt', () => {
  it('asks the Agent to summarize this Loop only (zh)', () => {
    const text = buildLoopReportPrompt({
      loopId: 'loop-abc',
      childJobCount: 6,
      zh: true,
    })
    expect(text).toContain('loop-abc')
    expect(text).toContain('约 6 个')
    expect(text).toContain('PROJECTS/loops/loop-abc.md')
    expect(text).toContain('不要混入')
  })

  it('asks the Agent to summarize this Loop only (en)', () => {
    const text = buildLoopReportPrompt({
      loopId: 'loop-abc',
      childJobCount: 0,
      zh: false,
    })
    expect(text).toContain('loop-abc')
    expect(text).toContain('PROJECTS/loops/loop-abc.md')
    expect(text).toMatch(/Do not mix/i)
  })
})
