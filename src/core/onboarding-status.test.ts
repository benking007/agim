import { describe, expect, it } from 'bun:test'
import { getOnboardingStatus } from './onboarding-status.js'
import type { Config } from './onboarding.js'

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    messengers: [],
    agents: ['agim'],
    defaultAgent: 'agim',
    ...overrides,
  }
}

describe('getOnboardingStatus', () => {
  it('marks first-run when no CLI agent and no LLM secret', () => {
    const status = getOnboardingStatus({
      config: cfg(),
      availableAgents: [],
      hasLlmSecret: false,
    })
    expect(status).toMatchObject({
      firstRun: true,
      reason: 'no-usable-agent',
      hasLlmSecret: false,
      availableCliAgents: [],
      defaultAgent: 'agim',
      skipped: false,
    })
  })

  it('is ready when an LLM secret exists, even without a CLI agent', () => {
    const status = getOnboardingStatus({
      config: cfg(),
      availableAgents: [],
      hasLlmSecret: true,
    })
    expect(status.firstRun).toBe(false)
    expect(status.reason).toBe('ready')
    expect(status.hasLlmSecret).toBe(true)
  })

  it('skips the wizard when a CLI agent is available', () => {
    const status = getOnboardingStatus({
      config: cfg({ defaultAgent: 'claude-code' }),
      availableAgents: ['claude-code'],
      hasLlmSecret: false,
    })
    expect(status.firstRun).toBe(false)
    expect(status.reason).toBe('cli-agent-available')
    expect(status.availableCliAgents).toEqual(['claude-code'])
    expect(status.defaultAgent).toBe('claude-code')
  })

  it('prefers ready over cli-agent-available when both apply', () => {
    const status = getOnboardingStatus({
      config: cfg(),
      availableAgents: ['agim', 'claude-code'],
      hasLlmSecret: true,
    })
    expect(status.firstRun).toBe(false)
    expect(status.reason).toBe('ready')
  })

  it('clears firstRun when setupSkipped is set', () => {
    const status = getOnboardingStatus({
      config: cfg({ setupSkipped: true }),
      availableAgents: [],
      hasLlmSecret: false,
    })
    expect(status.firstRun).toBe(false)
    expect(status.skipped).toBe(true)
    expect(status.reason).toBe('no-usable-agent')
  })

  it('does not treat a config file alone as initialized', () => {
    const status = getOnboardingStatus({
      config: cfg({
        messengers: [],
        agents: ['agim'],
        llmBackends: [{ name: 'deepseek-agim', provider: 'openai-compat' }],
      }),
      availableAgents: [],
      hasLlmSecret: false,
    })
    expect(status.firstRun).toBe(true)
    expect(status.reason).toBe('no-usable-agent')
  })
})
