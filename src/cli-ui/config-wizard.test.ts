import { describe, expect, it } from 'bun:test'

const { sectionForConfigComponent } = await import('./config-wizard.js')

describe('config shortcut routing', () => {
  it('routes legacy messenger shortcuts into the unified messenger section', () => {
    expect(sectionForConfigComponent('wechat')).toBe('messengers')
    expect(sectionForConfigComponent('wechat_ilink')).toBe('messengers')
    expect(sectionForConfigComponent('feishu')).toBe('messengers')
    expect(sectionForConfigComponent('dingtalk')).toBe('messengers')
  })

  it('routes agent and native shortcuts into their unified sections', () => {
    expect(sectionForConfigComponent('claude')).toBe('agents')
    expect(sectionForConfigComponent('claude-code')).toBe('agents')
    expect(sectionForConfigComponent('codex')).toBe('agents')
    expect(sectionForConfigComponent('native')).toBe('agim')
    expect(sectionForConfigComponent('llm')).toBe('agim')
  })

  it('rejects unknown shortcuts', () => {
    expect(sectionForConfigComponent('unknown')).toBeNull()
  })
})
