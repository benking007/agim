// /model command — exercises the per-agent driver dispatch added in
// v1.2.50. We can't reach the real opencode / cursor-agent binaries
// in unit tests, so this set verifies behaviour against the agent
// switch + error messages only.

import { describe, it, expect, beforeEach } from 'bun:test'
import { handleModelCommand, _internal } from './model.js'

const baseCtx = {
  platform: 'test',
  channelId: 'c',
  threadId: 't',
  defaultAgent: 'native',
  userId: 'u',
}

beforeEach(() => {
  _internal.invalidateModelCache()
})

describe('handleModelCommand — agent gating', () => {
  it('returns supported-agents hint when active agent has no model driver', async () => {
    // defaultAgent='native' has no ModelDriver registered today.
    const out = await handleModelCommand('', { ...baseCtx } as never)
    expect(out).toContain('不可用')
    expect(out).toContain('opencode')
    expect(out).toContain('cursor')
  })

  it('refresh works regardless of active agent', async () => {
    const out = await handleModelCommand('refresh', { ...baseCtx } as never)
    expect(out).toContain('缓存已清空')
  })
})
