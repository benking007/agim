import { describe, expect, it, mock, beforeEach } from 'bun:test'
import type { OnboardingStatus } from '../core/onboarding-status.js'

const pickLang = mock(async () => 'en' as const)
const loadOnboardingStatus = mock(async (): Promise<OnboardingStatus> => ({
  firstRun: false,
  reason: 'ready',
  hasLlmSecret: true,
  availableCliAgents: ['agim'],
  defaultAgent: 'agim',
  skipped: false,
}))
const menu = mock(async () => 'quit')

mock.module('./lang-picker.js', () => ({ pickLang }))
mock.module('../core/onboarding-status.js', () => ({ loadOnboardingStatus }))
mock.module('./prompts.js', () => ({
  BACK: Symbol('back'),
  UserAbortError: class UserAbortError extends Error {},
  menu,
}))

const { runEntryMenu } = await import('./entry-menu.js')

describe('runEntryMenu first-run passthrough', () => {
  beforeEach(() => {
    pickLang.mockClear()
    loadOnboardingStatus.mockClear()
    menu.mockClear()
  })

  it('skips the menu and returns quickstart on first run', async () => {
    loadOnboardingStatus.mockResolvedValueOnce({
      firstRun: true,
      reason: 'no-usable-agent',
      hasLlmSecret: false,
      availableCliAgents: [],
      defaultAgent: 'agim',
      skipped: false,
    })
    const result = await runEntryMenu()
    expect(result).toEqual({ action: { kind: 'quickstart' }, lang: 'en' })
    expect(menu).not.toHaveBeenCalled()
  })

  it('shows the menu after setup was skipped', async () => {
    loadOnboardingStatus.mockResolvedValueOnce({
      firstRun: false,
      reason: 'no-usable-agent',
      hasLlmSecret: false,
      availableCliAgents: [],
      defaultAgent: 'agim',
      skipped: true,
    })
    const result = await runEntryMenu()
    expect(result.action).toEqual({ kind: 'quit' })
    expect(menu).toHaveBeenCalled()
  })
})
