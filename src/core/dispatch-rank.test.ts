import { describe, expect, it, afterEach } from 'bun:test'
import {
  buildLivePreferredPicks,
  formatPreferredPickLine,
  rankDispatchCandidates,
  resolveListedCliAgentIds,
  type DispatchCandidate,
} from './dispatch-rank.js'
import { formatAgentProfilesForPrompt, mergeAgentProfiles } from './agent-profiles.js'
import { formatDispatchCheatSheetForPrompt, resolveDispatchRoutes } from './dispatch-routes.js'
import {
  clearAgentCache,
  peekAgentAvailabilitySnapshot,
  seedAgentAvailabilityCacheForTest,
} from './onboarding.js'

afterEach(() => {
  clearAgentCache()
})

describe('dispatch-rank', () => {
  it('ranks strong CLI above medium backend on coding', () => {
    const ranked = rankDispatchCandidates(
      [
        { kind: 'backend', id: 'pro', level: 'medium', label: 'agent=agim backend="pro"' },
        { kind: 'cli', id: 'codex', level: 'strong', label: 'agent=codex' },
      ],
      { preferKind: 'cli' },
    )
    expect(ranked[0]?.id).toBe('codex')
    expect(ranked[0]?.kind).toBe('cli')
  })

  it('on equal coding level prefers CLI over same-family backend', () => {
    const ranked = rankDispatchCandidates(
      [
        { kind: 'backend', id: 'pro', level: 'strong', label: 'agent=agim backend="pro"' },
        { kind: 'cli', id: 'claude-code', level: 'strong', label: 'agent=claude-code' },
      ],
      { preferKind: 'cli' },
    )
    expect(ranked[0]?.id).toBe('claude-code')
  })

  it('breaks coding ties with cheat-sheet order', () => {
    const ranked = rankDispatchCandidates(
      [
        { kind: 'cli', id: 'claude-code', level: 'strong', label: 'agent=claude-code' },
        { kind: 'cli', id: 'codex', level: 'strong', label: 'agent=codex' },
      ],
      { preferKind: 'cli', tieOrder: ['codex', 'claude-code'] },
    )
    expect(ranked.map((c) => c.id)).toEqual(['codex', 'claude-code'])
  })

  it('finance prefers backend when levels are equal', () => {
    const ranked = rankDispatchCandidates(
      [
        { kind: 'cli', id: 'codex', level: 'strong', label: 'agent=codex' },
        { kind: 'backend', id: 'pro', level: 'strong', label: 'agent=agim backend="pro"' },
      ],
      { preferKind: 'backend' },
    )
    expect(ranked[0]?.kind).toBe('backend')
  })

  it('does not dump all builtin CLI ids when nothing is enabled or available', () => {
    expect(resolveListedCliAgentIds({})).toEqual([])
    expect(formatAgentProfilesForPrompt(mergeAgentProfiles())).toBe('')
  })

  it('lists only enabled ∩ available CLI ids', () => {
    expect(resolveListedCliAgentIds({
      enabledAgents: ['codex', 'claude-code', 'agim'],
      availableAgents: ['codex', 'pi'],
      availabilityKnown: true,
    })).toEqual(['codex'])
  })

  it('omits unavailable CLI from live coding picks', () => {
    const text = buildLivePreferredPicks({
      cliIds: ['codex'],
      cliProfiles: {
        codex: { capabilities: {
          coding: 'strong',
          finance: 'medium',
          zhWriting: 'medium',
          reasoning: 'strong',
          dataCheck: 'strong',
        } },
      },
      backends: [{
        name: 'pro',
        capabilities: {
          coding: 'medium',
          finance: 'strong',
          zhWriting: 'strong',
          reasoning: 'strong',
          dataCheck: 'strong',
        },
      }],
      codingTieOrder: ['codex', 'claude-code'],
      availabilityKnown: true,
    })
    expect(text).toMatch(/coding → agent=codex \(strong\)/)
    expect(text).not.toMatch(/agent=claude-code/)
    expect(text).toMatch(/finance → agent=agim backend="pro" \(strong\)/)
  })

  it('coding fallback when no CLI is listed', () => {
    const text = buildLivePreferredPicks({
      cliIds: [],
      cliProfiles: {},
      backends: [],
      availabilityKnown: true,
    })
    expect(text).toMatch(/no coding CLI available/)
  })

  it('formatPreferredPickLine joins with then', () => {
    const picks: DispatchCandidate[] = [
      { kind: 'cli', id: 'codex', level: 'strong', label: 'agent=codex' },
      { kind: 'cli', id: 'claude-code', level: 'strong', label: 'agent=claude-code' },
    ]
    expect(formatPreferredPickLine(picks)).toBe(
      'agent=codex (strong) then agent=claude-code (strong)',
    )
  })
})

describe('availability snapshot + cheat sheet', () => {
  it('peek is unknown until seeded; cheat sheet drops missing CLIs', () => {
    expect(peekAgentAvailabilitySnapshot()).toEqual({
      known: false,
      available: [],
      missing: [],
    })
    seedAgentAvailabilityCacheForTest({
      available: ['codex'],
      missing: ['claude-code'],
      allMissing: false,
    })
    expect(peekAgentAvailabilitySnapshot().available).toEqual(['codex'])

    const routes = resolveDispatchRoutes({
      roles: {},
      enabledAgents: ['codex', 'claude-code'],
      availableAgents: ['codex'],
    })
    expect(routes.codingAgents).toEqual(['codex'])
    const sheet = formatDispatchCheatSheetForPrompt(routes)
    expect(sheet).toMatch(/agent=codex/)
    expect(sheet).not.toMatch(/agent=claude-code/)
  })

  it('cheat sheet does not invent default CLIs when none remain', () => {
    const routes = resolveDispatchRoutes({
      roles: {},
      enabledAgents: ['agim'],
      availableAgents: [],
    })
    expect(routes.codingAgents).toEqual([])
    expect(formatDispatchCheatSheetForPrompt(routes)).toMatch(/no coding CLI available/)
    expect(formatDispatchCheatSheetForPrompt(routes)).not.toMatch(/agent=codex/)
  })
})
