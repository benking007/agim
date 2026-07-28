import { describe, expect, it } from 'bun:test'
import {
  CALL_AGENT_TOOL_DESCRIPTION,
  CALL_AGENTS_TOOL_DESCRIPTION,
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

  it('locks Subagent deliverable contract (findings in message + path + no empty see above)', () => {
    expect(CALL_AGENT_TOOL_DESCRIPTION).toMatch(/absolute path/i)
    expect(CALL_AGENT_TOOL_DESCRIPTION).toMatch(/see above/i)
    expect(CALL_AGENT_TOOL_DESCRIPTION).toMatch(/见上文/)
    expect(CALL_AGENTS_TOOL_DESCRIPTION).toMatch(/absolute path/i)
    expect(buildSubagentDelegationGuidance()).toMatch(/When YOU are a Subagent/)
    expect(buildSubagentDelegationGuidance()).toMatch(/执行结果/)
    expect(buildSubagentDelegationGuidance()).toMatch(/absolute path/i)
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
  it('embeds operator dispatch cheat sheet when provided', () => {
    const g = buildSubagentDelegationGuidance({
      dispatchCheatSheet: 'Task → dispatch cheat sheet\n  - Coding → agent=codex',
    })
    expect(g).toMatch(/Task → dispatch cheat sheet/)
    expect(g).toMatch(/agent=codex/)
  })

  it('steers capability fit (coding vs finance/zhWriting)', () => {
    const g = buildSubagentDelegationGuidance()
    expect(g).toMatch(/Capability fit/)
    expect(g).toMatch(/finance/)
    expect(g).toMatch(/zhWriting/)
  })
})
