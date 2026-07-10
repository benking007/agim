// Tests for onboarding module

import { describe, it, expect, } from 'bun:test'
import {
  checkMessengerConfig,
  formatAgentInstallHint,
  formatAgentNotAvailableError,
  formatMessengerStartError,
  type Config,
} from './onboarding.js'

describe('checkMessengerConfig', () => {
  it('returns needsOnboarding=true when messengers empty', () => {
    const config: Config = {
      messengers: [],
      agents: [],
      defaultAgent: 'claude-code',
    }

    const result = checkMessengerConfig(config)

    expect(result.needsOnboarding).toBe(true)
    expect(result.availableMessengers.length).toBeGreaterThan(0)
  })

  it('returns needsOnboarding=false when messengers populated', () => {
    const config: Config = {
      messengers: ['wechat-ilink'],
      agents: [],
      defaultAgent: 'claude-code',
    }

    const result = checkMessengerConfig(config)

    expect(result.needsOnboarding).toBe(false)
    expect(result.availableMessengers.length).toBe(0)
  })

  it('includes correct availableMessengers list (default = no Telegram/Discord)', () => {
    delete process.env.AGIM_ENABLE_GLOBAL_IM
    const config: Config = {
      messengers: [],
      agents: [],
      defaultAgent: 'claude-code',
    }

    const result = checkMessengerConfig(config)

    const ids = result.availableMessengers.map((m) => m.id)
    expect(ids).toContain('wechat-ilink')
    expect(ids).toContain('feishu')
    expect(ids).toContain('dingtalk')
    expect(ids).not.toContain('telegram')
    expect(ids).not.toContain('discord')
  })

  it('AGIM_ENABLE_GLOBAL_IM=1 surfaces Telegram + Discord again', () => {
    process.env.AGIM_ENABLE_GLOBAL_IM = '1'
    const config: Config = {
      messengers: [],
      agents: [],
      defaultAgent: 'claude-code',
    }

    const result = checkMessengerConfig(config)
    const ids = result.availableMessengers.map((m) => m.id)
    expect(ids).toContain('telegram')
    expect(ids).toContain('discord')
    delete process.env.AGIM_ENABLE_GLOBAL_IM
  })
})

describe('formatAgentInstallHint', () => {
  it('formats single agent correctly', () => {
    const hint = formatAgentInstallHint(['opencode'])

    expect(hint).toContain('opencode')
    expect(hint).toContain('npm i -g')
  })

  it('formats multiple agents correctly', () => {
    const hint = formatAgentInstallHint(['claude-code', 'codex'])

    expect(hint).toContain('npm i -g')
    expect(hint).toContain('@anthropic-ai/claude-code')
    expect(hint).toContain('@openai/codex')
  })

  it('uses generic guidance for unknown agents', () => {
    const hint = formatAgentInstallHint(['unknown-agent'])

    expect(hint).toContain('unknown-agent')
    expect(hint).toContain('Install the unknown-agent adapter')
    expect(hint).toContain('CLI is on PATH')
  })

  it('returns empty string for empty array', () => {
    const hint = formatAgentInstallHint([])

    expect(hint).toBe('')
  })
})

describe('formatAgentNotAvailableError', () => {
  it('includes install command for opencode', () => {
    const error = formatAgentNotAvailableError('opencode')

    expect(error).toContain('opencode')
    expect(error).toContain('not installed')
    expect(error).toContain('npm i -g opencode')
  })

  it('includes install command for claude-code', () => {
    const error = formatAgentNotAvailableError('claude-code')

    expect(error).toContain('claude-code')
    expect(error).toContain('npm i -g @anthropic-ai/claude-code')
  })

  it('includes alternative agent suggestions', () => {
    const error = formatAgentNotAvailableError('codex')

    expect(error).toContain('/cc')
    expect(error).toContain('/cx')
    expect(error).toContain('/co')
    expect(error).toContain('/oc')
  })

  it('uses generic guidance for unknown agents', () => {
    const error = formatAgentNotAvailableError('unknown-agent')

    expect(error).toContain('unknown-agent')
    expect(error).toContain('Install the unknown-agent adapter')
    expect(error).toContain('CLI is on PATH')
  })
})

describe('formatMessengerStartError', () => {
  it('shows config hint for credential errors', () => {
    const error = new Error('No credentials found')
    const hint = formatMessengerStartError('wechat-ilink', error)

    expect(hint).toContain('agim config wechat')
  })

  it('shows config hint for auth errors', () => {
    const error = new Error('Authentication failed')
    const hint = formatMessengerStartError('telegram', error)

    expect(hint).toContain('agim config telegram')
  })

  it('returns original message for other errors', () => {
    const error = new Error('Network timeout')
    const hint = formatMessengerStartError('wechat-ilink', error)

    expect(hint).toBe('Network timeout')
  })

  it('handles non-Error objects', () => {
    const hint = formatMessengerStartError('feishu', 'string error')

    expect(hint).toBe('string error')
  })

  it('removes -ilink suffix for config hint', () => {
    const error = new Error('No credentials')
    const hint = formatMessengerStartError('wechat-ilink', error)

    expect(hint).toContain('agim config wechat')
    expect(hint).not.toContain('wechat-ilink')
  })
})
