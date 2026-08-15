import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  _resetAskBusForTests,
  handleAskOp,
  tryResolvePendingAsk,
} from './ask-user-rpc.js'
import { registry } from './registry.js'
import type { ChoiceCardPrompt, MessengerAdapter } from './types.js'
import { _setTestLiveSubagents } from './loop-run.js'
import {
  isLoopVerifyGateOn,
  isLoopVerdictToolName,
  loopNeedsVerdict,
  loopVerifyFollowUpPrompt,
  loopVerifySteerText,
  maybeReapIdleLoopVerify,
  isLoopAutoVerifyInFlight,
} from './loop-verify-gate.js'
import { formatLoopRoundEvidence, isLoopAutoVerifyEnabled } from './loop-evaluator.js'
import type { LoopRun } from './loop-run.js'

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
    delete process.env.AGIM_LOOP_AUTO_VERIFY
    _setTestLiveSubagents(false)
    _resetAskBusForTests()
  })

  afterEach(() => {
    _setTestLiveSubagents(null)
    _resetAskBusForTests()
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

  it('does not need verdict while ask_user awaits user reply', async () => {
    const a = seedLoop(process.env.AGIM_LOOPS_DIR!)
    const m: MessengerAdapter = {
      name: a.platform,
      async start() { /* noop */ },
      async stop() { /* noop */ },
      onMessage() { /* noop */ },
      async sendMessage() { /* noop */ },
      async sendChoiceCard(_threadId: string, _prompt: ChoiceCardPrompt) {
        return { messageId: 'm-ask' }
      },
    }
    registry.registerMessenger(m)
    const pending = handleAskOp(
      { question: '结论不确定，采用哪条？', choices: ['继续', '修订'], timeoutSec: 30 },
      { platform: a.platform, channelId: a.channelId, threadId: a.threadId, userId: 'u1' },
    )
    await new Promise<void>((r) => setImmediate(r))
    expect(loopNeedsVerdict(a.platform, a.channelId, a.threadId)).toBe(false)
    tryResolvePendingAsk(a.platform, a.channelId, a.threadId, '继续')
    await pending
    expect(loopNeedsVerdict(a.platform, a.channelId, a.threadId)).toBe(true)
  })

  it('steer + follow-up copy mention loop_verdict and mid-review ask_user', () => {
    expect(loopVerifySteerText()).toContain('loop_verdict')
    expect(loopVerifySteerText()).toContain('ask_user')
    expect(loopVerifySteerText()).toContain('parent verifier')
    expect(loopVerifySteerText()).toContain('确认结束')
    expect(loopVerifyFollowUpPrompt()).toContain('loop_verdict')
    expect(loopVerifyFollowUpPrompt()).toContain('ask_user')
  })

  it('AGIM_LOOP_AUTO_VERIFY defaults off and reads env', () => {
    delete process.env.AGIM_LOOP_AUTO_VERIFY
    expect(isLoopAutoVerifyEnabled()).toBe(false)
    process.env.AGIM_LOOP_AUTO_VERIFY = '1'
    expect(isLoopAutoVerifyEnabled()).toBe(true)
    process.env.AGIM_LOOP_AUTO_VERIFY = 'on'
    expect(isLoopAutoVerifyEnabled()).toBe(true)
    process.env.AGIM_LOOP_AUTO_VERIFY = 'off'
    expect(isLoopAutoVerifyEnabled()).toBe(false)
    delete process.env.AGIM_LOOP_AUTO_VERIFY
  })

  it('reaper without auto-verify defers while rounds remain', () => {
    delete process.env.AGIM_LOOP_AUTO_VERIFY
    const a = seedLoop(process.env.AGIM_LOOPS_DIR!)
    const r = maybeReapIdleLoopVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(false)
    expect(isLoopAutoVerifyInFlight()).toBe(false)
  })

  it('reaper without auto-verify ends on the last round', () => {
    delete process.env.AGIM_LOOP_AUTO_VERIFY
    const a = seedLoop(process.env.AGIM_LOOPS_DIR!, { round: 3, maxRounds: 3 })
    const r = maybeReapIdleLoopVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(true)
    if (r.ended) expect(r.run.endReason).toBe('limit')
    expect(isLoopAutoVerifyInFlight()).toBe(false)
  })

  it('reaper with auto-verify builds its own route ctx and defers (loop stays active)', async () => {
    process.env.AGIM_LOOP_AUTO_VERIFY = '1'
    const a = seedLoop(process.env.AGIM_LOOPS_DIR!)
    const r = maybeReapIdleLoopVerify(a.platform, a.channelId, a.threadId)
    // Reviewer is fire-and-forget; the Loop is NOT ended synchronously.
    expect(r.ended).toBe(false)
    expect(isLoopAutoVerifyInFlight(a.platform, a.channelId, a.threadId)).toBe(true)
    expect(isLoopAutoVerifyInFlight('other', 'c', 't-other')).toBe(false)
    // Give the async reviewer a beat to settle (it will fail: no cheap backend
    // in this unit env → falls back to verify_skipped).
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    expect(isLoopAutoVerifyInFlight(a.platform, a.channelId, a.threadId)).toBe(false)
  })

  it('formatLoopRoundEvidence lists job ids and degrades when the board is empty', () => {
    const run = {
      roundJobIds: [11, 12],
    } as LoopRun
    const text = formatLoopRoundEvidence(run)
    expect(text).toContain('#11')
    expect(text).toContain('#12')
    expect(formatLoopRoundEvidence({ roundJobIds: [] } as unknown as LoopRun))
      .toContain('no Subagent results')
  })
})
