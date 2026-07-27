import { describe, expect, it } from 'bun:test'
import {
  buildCriticUserBlock,
  isConcreteTurnAsk,
  shouldHardStopOnOffTrack,
} from './goal-critic.js'

describe('goal-critic Focus vs current ask', () => {
  it('treats explicit asks as concrete (outrank Focus)', () => {
    expect(isConcreteTurnAsk('折叠侧栏')).toBe(true)
    expect(isConcreteTurnAsk('帮我改一下 CSS')).toBe(true)
    expect(isConcreteTurnAsk('派 codex 修 bug')).toBe(true)
  })

  it('treats bare continuations as non-concrete', () => {
    expect(isConcreteTurnAsk('继续')).toBe(false)
    expect(isConcreteTurnAsk('continue')).toBe(false)
    expect(isConcreteTurnAsk('接着做')).toBe(false)
    expect(isConcreteTurnAsk('')).toBe(false)
    expect(isConcreteTurnAsk(undefined)).toBe(false)
  })

  it('never hard-stops when the turn has a concrete ask', () => {
    expect(shouldHardStopOnOffTrack({ prompt: '折叠侧栏' })).toBe(false)
    expect(shouldHardStopOnOffTrack({ prompt: '继续' })).toBe(true)
    expect(shouldHardStopOnOffTrack({ prompt: '' })).toBe(true)
  })

  it('labels Focus as background when current ask is concrete', () => {
    const block = buildCriticUserBlock({
      prompt: '折叠侧栏',
      goalTitle: '投资分析',
      goalBody: '检查持仓与信号雷达',
      recentToolCalls: [{ name: 'native_read_file', isError: false, preview: 'sidebar.css' }],
    })
    expect(block).toContain('本轮用户请求 — 唯一硬目标')
    expect(block).toContain('折叠侧栏')
    expect(block).toContain('Focus 背景 — 仅 context')
    expect(block).toContain('投资分析')
    expect(block).not.toContain('本轮锚点（因用户未给新的具体请求）')
  })

  it('uses Focus as anchor only for bare continuations', () => {
    const block = buildCriticUserBlock({
      prompt: '继续',
      goalTitle: '投资分析',
      goalBody: '检查持仓',
      recentToolCalls: [],
    })
    expect(block).toContain('Focus — 本轮锚点')
    expect(block).toContain('投资分析')
    expect(block).not.toContain('唯一硬目标')
  })
})
