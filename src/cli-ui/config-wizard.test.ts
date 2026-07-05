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
    expect(sectionForConfigComponent('copilot')).toBe('agents')
    expect(sectionForConfigComponent('co')).toBe('agents')
    expect(sectionForConfigComponent('gh-copilot')).toBe('agents')
    expect(sectionForConfigComponent('github-copilot')).toBe('agents')
    expect(sectionForConfigComponent('antigravity')).toBe('agents')
    expect(sectionForConfigComponent('agy')).toBe('agents')
    expect(sectionForConfigComponent('gemini')).toBe('agents')
    expect(sectionForConfigComponent('ag')).toBe('agents')
    expect(sectionForConfigComponent('kimi')).toBe('agents')
    expect(sectionForConfigComponent('kimi-code')).toBe('agents')
    expect(sectionForConfigComponent('qoder')).toBe('agents')
    expect(sectionForConfigComponent('qd')).toBe('agents')
    expect(sectionForConfigComponent('pi')).toBe('agents')
    expect(sectionForConfigComponent('pi-agent')).toBe('agents')
    expect(sectionForConfigComponent('mimo')).toBe('agents')
    expect(sectionForConfigComponent('mo')).toBe('agents')
    expect(sectionForConfigComponent('mimo-code')).toBe('agents')
    expect(sectionForConfigComponent('native')).toBe('agim')
    expect(sectionForConfigComponent('llm')).toBe('agim')
  })

  it('rejects unknown shortcuts', () => {
    expect(sectionForConfigComponent('unknown')).toBeNull()
  })
})
