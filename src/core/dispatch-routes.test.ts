import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_DISPATCH_CODING_AGENTS,
  DISPATCH_DATA_ROLE,
  DISPATCH_FINANCE_ROLE,
  dispatchRoutesForPersist,
  formatDispatchCheatSheetForPrompt,
  readDispatchRoutesStored,
  resolveDispatchRoutes,
} from './dispatch-routes.js'

describe('dispatch-routes', () => {
  it('defaults coding agents and unbound finance/cheap backends', () => {
    const r = resolveDispatchRoutes({ roles: {} })
    expect(r.codingAgents).toEqual([...DEFAULT_DISPATCH_CODING_AGENTS])
    expect(r.finance.agent).toBe('agim')
    expect(r.finance.backend).toBeNull()
    expect(r.finance.role).toBe(DISPATCH_FINANCE_ROLE)
    expect(r.dataCollect.role).toBe(DISPATCH_DATA_ROLE)
    expect(r.dataCollect.backend).toBeNull()
  })

  it('reads llmRoles.finance / cheap and custom agents', () => {
    const r = resolveDispatchRoutes({
      config: {
        dispatchRoutes: {
          codingAgents: ['opencode', 'codex'],
          financeAgent: 'agim',
          dataAgent: 'agim',
        },
      },
      roles: {
        finance: 'kimi-k2.6',
        cheap: 'kimi-flash',
      },
    })
    expect(r.codingAgents).toEqual(['opencode', 'codex'])
    expect(r.finance.backend).toBe('kimi-k2.6')
    expect(r.dataCollect.backend).toBe('kimi-flash')
  })

  it('cheat sheet uses configured backends and never invents deepseek', () => {
    const text = formatDispatchCheatSheetForPrompt(
      resolveDispatchRoutes({
        roles: { finance: 'my-pro', cheap: 'my-flash' },
      }),
    )
    expect(text).toMatch(/backend="my-pro"/)
    expect(text).toMatch(/backend="my-flash"/)
    expect(text).toMatch(/agent=codex/)
    expect(text.toLowerCase()).not.toMatch(/deepseek/)
  })

  it('drops coding CLIs that are not enabled or not available', () => {
    const r = resolveDispatchRoutes({
      roles: {},
      enabledAgents: ['codex', 'agim'],
      availableAgents: ['codex'],
    })
    expect(r.codingAgents).toEqual(['codex'])
    expect(formatDispatchCheatSheetForPrompt(
      resolveDispatchRoutes({ roles: {}, enabledAgents: ['agim'] }),
    )).toMatch(/no coding CLI available/)
  })

  it('unbound finance asks operator to pick a backend in Settings', () => {
    const text = formatDispatchCheatSheetForPrompt(resolveDispatchRoutes({ roles: {} }))
    expect(text).toMatch(/llmRoles\.finance/)
    expect(text).toMatch(/Settings/)
  })

  it('persist omits defaults', () => {
    expect(dispatchRoutesForPersist({
      codingAgents: [...DEFAULT_DISPATCH_CODING_AGENTS],
      financeAgent: 'agim',
      dataAgent: 'agim',
    })).toBeUndefined()
    expect(dispatchRoutesForPersist({
      codingAgents: ['opencode'],
    })).toEqual({ codingAgents: ['opencode'] })
  })

  it('readDispatchRoutesStored ignores agim in codingAgents', () => {
    const s = readDispatchRoutesStored({
      dispatchRoutes: { codingAgents: ['agim', 'codex', 'codex'] },
    })
    expect(s.codingAgents).toEqual(['codex'])
  })
})
