import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _setTestLiveSubagents } from './loop-run.js'
import {
  isLoopVerifyGateOn,
  isLoopVerdictToolName,
  loopNeedsVerdict,
  loopVerifyFollowUpPrompt,
  loopVerifySteerText,
} from './loop-verify-gate.js'

function seedLoop(dir: string, over: Record<string, unknown> = {}): {
  platform: string
  channelId: string
  threadId: string
} {
  const platform = 'web'
  const channelId = 'web'
  const threadId = `t-verify-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
  const sessionKey = `${platform}__${channelId}__${threadId}`
  const now = Date.now()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, `${sessionKey}.json`), JSON.stringify({
    id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionKey,
    platform,
    channelId,
    threadId,
    focusSnapshot: '分析金价',
    openedFocus: false,
    status: 'dispatching',
    round: 1,
    maxRounds: 3,
    mission: {
      objective: '分析金价箱体',
      exit: { description: '找到箱体或最多3轮', maxRounds: 3, onFocusOff: 'cancel' },
    },
    dispatchesThisRound: 3,
    usage: { dispatchCount: 3, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
    lastPlan: {
      at: now,
      tasks: [{ id: '1', brief: 'fetch', agentHint: 'agim' }],
    },
    createdAt: now,
    updatedAt: now,
    timeline: [],
    ...over,
  }), 'utf8')
  return { platform, channelId, threadId }
}

describe('loop verify gate', () => {
  let dir: string
  const prevLoops = process.env.AGIM_LOOPS_DIR
  const prevGate = process.env.AGIM_LOOP_VERIFY_GATE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-verify-gate-'))
    process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
    delete process.env.AGIM_LOOP_VERIFY_GATE
    _setTestLiveSubagents(false)
  })

  afterEach(() => {
    _setTestLiveSubagents(null)
    if (prevLoops === undefined) delete process.env.AGIM_LOOPS_DIR
    else process.env.AGIM_LOOPS_DIR = prevLoops
    if (prevGate === undefined) delete process.env.AGIM_LOOP_VERIFY_GATE
    else process.env.AGIM_LOOP_VERIFY_GATE = prevGate
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('reads AGIM_LOOP_VERIFY_GATE', () => {
    process.env.AGIM_LOOP_VERIFY_GATE = 'off'
    expect(isLoopVerifyGateOn()).toBe(false)
    delete process.env.AGIM_LOOP_VERIFY_GATE
    expect(isLoopVerifyGateOn()).toBe(true)
  })

  it('detects loop_verdict tool names', () => {
    expect(isLoopVerdictToolName('mcp__agim__loop_verdict')).toBe(true)
    expect(isLoopVerdictToolName('loop_verdict')).toBe(true)
    expect(isLoopVerdictToolName('call_agents')).toBe(false)
  })

  it('needs verdict after dispatch, not before, not when ended', () => {
    const a = seedLoop(process.env.AGIM_LOOPS_DIR!)
    expect(loopNeedsVerdict(a.platform, a.channelId, a.threadId)).toBe(true)

    const b = seedLoop(process.env.AGIM_LOOPS_DIR!, {
      dispatchesThisRound: 0,
      status: 'planning',
      usage: { dispatchCount: 0, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
    })
    expect(loopNeedsVerdict(b.platform, b.channelId, b.threadId)).toBe(false)

    const c = seedLoop(process.env.AGIM_LOOPS_DIR!, {
      status: 'ended',
      endReason: 'objective_met',
    })
    expect(loopNeedsVerdict(c.platform, c.channelId, c.threadId)).toBe(false)
  })

  it('can be disabled via env', () => {
    process.env.AGIM_LOOP_VERIFY_GATE = 'off'
    const a = seedLoop(process.env.AGIM_LOOPS_DIR!)
    expect(loopNeedsVerdict(a.platform, a.channelId, a.threadId)).toBe(false)
  })

  it('does not need verdict while Subagents are still live', () => {
    const a = seedLoop(process.env.AGIM_LOOPS_DIR!)
    _setTestLiveSubagents(true)
    expect(loopNeedsVerdict(a.platform, a.channelId, a.threadId)).toBe(false)
    _setTestLiveSubagents(false)
    expect(loopNeedsVerdict(a.platform, a.channelId, a.threadId)).toBe(true)
  })

  it('steer + follow-up copy mention loop_verdict', () => {
    expect(loopVerifySteerText()).toContain('loop_verdict')
    expect(loopVerifyFollowUpPrompt()).toContain('loop_verdict')
  })
})
