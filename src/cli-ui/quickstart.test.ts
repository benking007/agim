import { describe, expect, it, mock, beforeEach } from 'bun:test'

const loadConfig = mock(async () => ({
  messengers: [],
  agents: ['agim'],
  defaultAgent: 'agim',
}))
const saveConfigChanges = mock(async (_base: unknown, next: unknown) => next)
const markSetupSkipped = mock(async () => undefined)
const checkAgentsFresh = mock(async () => ({ available: [] as string[], missing: ['claude-code'] }))
const pickPreferredAgent = mock((available: string[]): string | null => available[0] ?? null)
const offerServiceStart = mock(async () => undefined)

mock.module('../core/onboarding.js', () => ({
  loadConfig,
  saveConfigChanges,
}))
mock.module('../core/onboarding-status.js', () => ({ markSetupSkipped }))
mock.module('./readiness.js', () => ({ checkAgentsFresh, pickPreferredAgent }))
mock.module('./cmd-handlers.js', () => ({ offerServiceStart }))
mock.module('./retire-acp-residue.js', () => ({
  purgeRetiredAcpResidue: async () => undefined,
}))

const { runQuickstart } = await import('./quickstart.js')

describe('runQuickstart', () => {
  beforeEach(() => {
    loadConfig.mockClear()
    offerServiceStart.mockClear()
    checkAgentsFresh.mockClear()
    pickPreferredAgent.mockClear()
  })

  it('opens /setup when no agent is available', async () => {
    checkAgentsFresh.mockResolvedValueOnce({ available: [], missing: ['claude-code'] })
    pickPreferredAgent.mockReturnValueOnce(null)
    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    try {
      await runQuickstart('en')
    } finally {
      console.log = orig
    }
    expect(offerServiceStart).toHaveBeenCalledWith('en', {
      path: '/setup',
      open: true,
      assumeYes: true,
    })
    expect(logs.some((line) => line.includes('Finish setup in the browser'))).toBe(true)
  })

  it('keeps the existing start path when a CLI agent is available', async () => {
    checkAgentsFresh.mockResolvedValueOnce({ available: ['claude-code'], missing: [] })
    pickPreferredAgent.mockReturnValueOnce('claude-code')
    await runQuickstart('en')
    expect(offerServiceStart).toHaveBeenCalledWith('en', { welcome: true })
  })
})
