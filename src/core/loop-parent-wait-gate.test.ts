import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _setTestLiveSubagents } from './loop-run.js'
import { evaluateLoopParentWaitGate } from './loop-parent-wait-gate.js'

function seed(dir: string, over: Record<string, unknown> = {}) {
  const platform = 'web'
  const channelId = 'web'
  const threadId = `t-wait-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
  const sessionKey = `${platform}__${channelId}__${threadId}`
  const now = Date.now()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, `${sessionKey}.json`), JSON.stringify({
    id: 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionKey,
    platform,
    channelId,
    threadId,
    focusSnapshot: '分析',
    openedFocus: false,
    status: 'dispatching',
    round: 1,
    maxRounds: 6,
    mission: {
      objective: '分析',
      exit: { description: '重复3轮', maxRounds: 6, minRounds: 3, onFocusOff: 'cancel' },
    },
    dispatchesThisRound: 2,
    roundJobIds: [],
    usage: { dispatchCount: 2, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
    createdAt: now,
    updatedAt: now,
    timeline: [],
    ...over,
  }), 'utf8')
  return { platform, channelId, threadId }
}

describe('loop parent wait gate', () => {
  let dir: string
  const prevLoops = process.env.AGIM_LOOPS_DIR
  const prevGate = process.env.AGIM_LOOP_DISPATCH_GATE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-wait-gate-'))
    process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
    delete process.env.AGIM_LOOP_DISPATCH_GATE
    _setTestLiveSubagents(false)
  })

  afterEach(() => {
    _setTestLiveSubagents(null)
    if (prevLoops === undefined) delete process.env.AGIM_LOOPS_DIR
    else process.env.AGIM_LOOPS_DIR = prevLoops
    if (prevGate === undefined) delete process.env.AGIM_LOOP_DISPATCH_GATE
    else process.env.AGIM_LOOP_DISPATCH_GATE = prevGate
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('blocks research after dispatch; allows sleep, ask_user, and loop_verdict when idle', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'web_fetch').ok).toBe(false)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'mcp__agim__call_agents').ok).toBe(false)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'agim_sleep_ms').ok).toBe(true)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'mcp__agim__ask_user').ok).toBe(true)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'ask_user').ok).toBe(true)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'mcp__agim__loop_verdict').ok).toBe(true)
  })

  it('blocks loop_verdict AND ask_user while round Subagents are live', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!)
    _setTestLiveSubagents(true)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'mcp__agim__loop_verdict').ok).toBe(false)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'mcp__agim__ask_user').ok).toBe(false)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'agim_sleep_ms').ok).toBe(true)
    const denied = evaluateLoopParentWaitGate(
      a.platform, a.channelId, a.threadId, 'mcp__agim__ask_user',
    )
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toContain('Do NOT ask_user to unblock')
  })

  it('pending_user_confirm blocks research, verdict, and ask_user', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!, {
      status: 'pending_user_confirm',
      lastVerification: { met: true, summary: 'done', at: Date.now() },
    })
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'web_fetch').ok).toBe(false)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'mcp__agim__loop_verdict').ok).toBe(false)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'mcp__agim__ask_user').ok).toBe(false)
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'agim_now').ok).toBe(true)
  })

  it('allows tools again in planning after round reset', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!, {
      status: 'planning',
      dispatchesThisRound: 0,
      round: 2,
    })
    expect(evaluateLoopParentWaitGate(a.platform, a.channelId, a.threadId, 'web_fetch').ok).toBe(true)
  })
})
