import { describe, it, expect, afterEach } from 'bun:test'
import {
  resolveToolPacks,
  TOOL_PACK_DEFAULTS,
  TOOL_PACK_LEGACY_ALL_ON,
  describeEnabledToolPacks,
  planModeReadToolsHint,
} from './tool-packs.js'
import { setLiveConfig, __resetLiveConfigForTest } from '../live-config.js'
import { assembleNativeTools } from '../../plugins/agents/agim-agent-shared/tool-registry.js'

describe('tool-packs', () => {
  afterEach(() => {
    __resetLiveConfigForTest()
  })

  it('absent toolPacks → legacy all-on', () => {
    expect(resolveToolPacks(undefined)).toEqual({ ...TOOL_PACK_LEGACY_ALL_ON })
    expect(resolveToolPacks(null)).toEqual({ ...TOOL_PACK_LEGACY_ALL_ON })
  })

  it('partial object fills defaults (codingGate off)', () => {
    expect(resolveToolPacks({})).toEqual({ ...TOOL_PACK_DEFAULTS })
    expect(resolveToolPacks({ git: false })).toEqual({
      git: false,
      codingGate: false,
      web: true,
    })
  })

  it('describeEnabledToolPacks omits disabled packs', () => {
    const lines = describeEnabledToolPacks({ git: true, codingGate: false, web: false })
    expect(lines.some((l) => l.includes('git'))).toBe(true)
    expect(lines.some((l) => l.includes('quality_gate') || l.includes('diagnostics'))).toBe(false)
    expect(lines.some((l) => l.includes('web_fetch'))).toBe(false)
  })

  it('planModeReadToolsHint follows packs', () => {
    const hint = planModeReadToolsHint({ git: false, codingGate: true, web: false })
    expect(hint).toContain('agim_diagnostics')
    expect(hint).not.toContain('agim_git_status')
    expect(hint).not.toContain('agim_web_fetch')
  })

  it('assembleNativeTools respects toolPacks filter', () => {
    const base = {
      cwd: '/tmp',
      todoThreadKey: 't',
      planExitCtx: { threadKey: 't', runId: 'r' },
      advertisePlanExit: false,
      agimCtx: {
        platform: 'native-agent', channelId: 'c', threadId: 't',
        userId: 'u', callerAgent: 'native', callerDepth: 0,
      },
    }
    const off = assembleNativeTools({
      ...base,
      toolPacks: { git: false, codingGate: false, web: false },
    })
    const names = new Set(off.tools.map((t) => t.name))
    expect(names.has('agim_read_file')).toBe(true)
    expect(names.has('agim_exec')).toBe(true)
    expect(names.has('agim_git_status')).toBe(false)
    expect(names.has('agim_diagnostics')).toBe(false)
    expect(names.has('agim_web_fetch')).toBe(false)

    const on = assembleNativeTools({
      ...base,
      toolPacks: { git: true, codingGate: true, web: true },
    })
    const onNames = new Set(on.tools.map((t) => t.name))
    expect(onNames.has('agim_git_status')).toBe(true)
    expect(onNames.has('agim_quality_gate')).toBe(true)
    expect(onNames.has('agim_web_search')).toBe(true)
  })

  it('live config drives assemble when toolPacks omitted', () => {
    setLiveConfig({
      messengers: [],
      agents: ['agim'],
      defaultAgent: 'agim',
      toolPacks: { git: true, codingGate: false, web: false },
    } as never)
    const assembled = assembleNativeTools({
      cwd: '/tmp',
      todoThreadKey: 't',
      planExitCtx: { threadKey: 't', runId: 'r' },
      advertisePlanExit: false,
      agimCtx: {
        platform: 'native-agent', channelId: 'c', threadId: 't',
        userId: 'u', callerAgent: 'native', callerDepth: 0,
      },
    })
    const names = new Set(assembled.tools.map((t) => t.name))
    expect(names.has('agim_git_status')).toBe(true)
    expect(names.has('agim_diagnostics')).toBe(false)
    expect(names.has('agim_web_fetch')).toBe(false)
  })
})
