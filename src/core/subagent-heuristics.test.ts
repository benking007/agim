import { describe, expect, it } from 'bun:test'
import {
  CALL_AGENT_TOOL_DESCRIPTION,
  SUBAGENT_HEURISTIC_KEYWORDS,
  buildCallAgentToolDescription,
  buildSubagentDelegationGuidance,
} from './subagent-heuristics.js'

describe('subagent heuristics (Phase A3)', () => {
  it('tool description carries key decompose keywords', () => {
    const lower = CALL_AGENT_TOOL_DESCRIPTION.toLowerCase()
    for (const kw of SUBAGENT_HEURISTIC_KEYWORDS) {
      expect(lower).toContain(kw.toLowerCase())
    }
  })

  it('parent guidance carries the same keywords', () => {
    const lower = buildSubagentDelegationGuidance().toLowerCase()
    for (const kw of SUBAGENT_HEURISTIC_KEYWORDS) {
      expect(lower).toContain(kw.toLowerCase())
    }
  })

  it('keeps brief four-piece and anti-over-spawn rules explicit', () => {
    expect(CALL_AGENT_TOOL_DESCRIPTION).toMatch(/Objective/)
    expect(CALL_AGENT_TOOL_DESCRIPTION).toMatch(/do not spawn for trivial/i)
    expect(CALL_AGENT_TOOL_DESCRIPTION).toMatch(/do not parallel-write/i)
    expect(buildSubagentDelegationGuidance()).toMatch(/Brief four-piece/)
    expect(buildSubagentDelegationGuidance()).toMatch(/same-family/)
  })

  it('prefers concrete backend over role:cheap alias in guidance', () => {
    expect(CALL_AGENT_TOOL_DESCRIPTION).toMatch(/prefer backend/i)
    expect(buildSubagentDelegationGuidance()).toMatch(/do not assume/i)
    const live = buildCallAgentToolDescription({
      backends: ['mock-pro', 'mock-flash'],
      roles: ['cheap'],
    })
    expect(live).toMatch(/Configured llmBackends.*mock-pro/)
    expect(live).toMatch(/Optional llmRoles aliases: cheap/)
  })
})
