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
import {
  _resetLoopParentTurnsForTests,
  clearLoopParentTurnActive,
  markLoopParentTurnActive,
} from './loop-parent-turn.js'
import {
  _setTestLiveSubagents,
  forceLoopExitSkippedVerify,
  getActiveLoop,
  maybeEnforceLoopExit,
} from './loop-run.js'
import { maybeReapIdleLoopVerify } from './loop-verify-gate.js'

function registerFakeMessenger(name: string): void {
  const m: MessengerAdapter = {
    name,
    async start() { /* noop */ },
    async stop() { /* noop */ },
    onMessage() { /* noop */ },
    async sendMessage() { /* noop */ },
    async sendChoiceCard(_threadId: string, _prompt: ChoiceCardPrompt) {
      return { messageId: 'm-ask' }
    },
  }
  registry.registerMessenger(m)
}

function seed(dir: string, over: Record<string, unknown> = {}) {
  const platform = 'web'
  const channelId = 'web'
  const threadId = `t-exit-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
  const sessionKey = `${platform}__${channelId}__${threadId}`
  const now = Date.now()
  const fields = over.fields && typeof over.fields === 'object' && !Array.isArray(over.fields)
    ? over.fields as Record<string, unknown>
    : {}
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, `${sessionKey}.json`), JSON.stringify({
    id: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionKey,
    platform,
    channelId,
    threadId,
    focusSnapshot: '分析',
    openedFocus: false,
    status: 'dispatching',
    round: 1,
    maxRounds: 3,
    mission: {
      objective: '分析金价',
      exit: {
        description: '最多3轮',
        maxRounds: 3,
        onFocusOff: 'cancel',
        ...(over.wall ? { maxWallMs: 1 } : {}),
      },
    },
    dispatchesThisRound: 2,
    usage: { dispatchCount: 2, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
    createdAt: over.oldCreated ? now - 60_000 : now,
    updatedAt: now,
    timeline: [],
    ...fields,
  }), 'utf8')
  return { platform, channelId, threadId }
}

describe('loop exit enforce (no verdict required)', () => {
  let dir: string
  const prev = process.env.AGIM_LOOPS_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-exit-'))
    process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
    _setTestLiveSubagents(null)
    _resetAskBusForTests()
    _resetLoopParentTurnsForTests()
  })

  afterEach(() => {
    _setTestLiveSubagents(null)
    _resetAskBusForTests()
    _resetLoopParentTurnsForTests()
    if (prev === undefined) delete process.env.AGIM_LOOPS_DIR
    else process.env.AGIM_LOOPS_DIR = prev
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('maybeEnforceLoopExit ends on wall without verdict', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!, { wall: true, oldCreated: true })
    const r = maybeEnforceLoopExit(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(true)
    expect(r.reason).toBe('wall_limit')
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).toBeNull()
  })

  it('maybeEnforceLoopExit defers wall while Subagents are live', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!, { wall: true, oldCreated: true })
    _setTestLiveSubagents(true)
    const r = maybeEnforceLoopExit(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(false)
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).not.toBeNull()
  })

  it('forceLoopExitSkippedVerify defers when rounds remain (avoids no_active_loop)', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!)
    const r = forceLoopExitSkippedVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(false)
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).not.toBeNull()
  })

  it('forceLoopExitSkippedVerify can still simulate a premature verify_skipped reap', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!)
    const r = forceLoopExitSkippedVerify(a.platform, a.channelId, a.threadId, {
      ignoreRemainingRounds: true,
    })
    expect(r.ended).toBe(true)
    expect(r.reason).toBe('verify_skipped')
    expect(r.run?.endReason).toBe('verify_skipped')
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).toBeNull()
  })

  it('forceLoopExitSkippedVerify defers while Subagents are live', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!)
    _setTestLiveSubagents(true)
    const r = forceLoopExitSkippedVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(false)
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).not.toBeNull()
  })

  it('forceLoopExitSkippedVerify defers while ask_user awaits user reply', async () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!, {
      fields: { round: 3, maxRounds: 3 },
    })
    registerFakeMessenger(a.platform)
    const pending = handleAskOp(
      { question: '数据异常，采用哪组？', choices: ['A', 'B'], timeoutSec: 30 },
      { platform: a.platform, channelId: a.channelId, threadId: a.threadId, userId: 'u1' },
    )
    await new Promise<void>((r) => setImmediate(r))
    const deferred = forceLoopExitSkippedVerify(a.platform, a.channelId, a.threadId)
    expect(deferred.ended).toBe(false)
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).not.toBeNull()
    tryResolvePendingAsk(a.platform, a.channelId, a.threadId, 'A')
    await pending
    const after = forceLoopExitSkippedVerify(a.platform, a.channelId, a.threadId)
    expect(after.ended).toBe(true)
    expect(after.reason).toBe('limit')
  })

  it('forceLoopExitSkippedVerify uses limit when round already at max', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!, {
      fields: { round: 3, maxRounds: 3 },
    })
    const r = forceLoopExitSkippedVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(true)
    expect(r.reason).toBe('limit')
  })

  it('maybeEnforceLoopExit no-ops when wall not set', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!)
    const r = maybeEnforceLoopExit(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(false)
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).not.toBeNull()
  })

  it('maybeReapIdleLoopVerify defers when rounds remain (avoids no_active_loop)', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!)
    _setTestLiveSubagents(false)
    const r = maybeReapIdleLoopVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(false)
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).not.toBeNull()
  })

  it('maybeReapIdleLoopVerify ends stuck VERIFY on the last round when parent idle', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!, {
      fields: { round: 3, maxRounds: 3 },
    })
    _setTestLiveSubagents(false)
    const r = maybeReapIdleLoopVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(true)
    expect(r.reason).toBe('limit')
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).toBeNull()
  })

  it('maybeReapIdleLoopVerify defers while parent turn is in-flight', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!, {
      fields: { round: 3, maxRounds: 3 },
    })
    _setTestLiveSubagents(false)
    markLoopParentTurnActive(a.platform, a.channelId, a.threadId)
    const r = maybeReapIdleLoopVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(false)
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).not.toBeNull()
    clearLoopParentTurnActive(a.platform, a.channelId, a.threadId)
    const after = maybeReapIdleLoopVerify(a.platform, a.channelId, a.threadId)
    expect(after.ended).toBe(true)
  })

  it('maybeReapIdleLoopVerify treats parent as in-flight across channel aliases', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!, {
      fields: { round: 3, maxRounds: 3 },
    })
    _setTestLiveSubagents(false)
    markLoopParentTurnActive(a.platform, '', a.threadId)
    const r = maybeReapIdleLoopVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(false)
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).not.toBeNull()
  })

  it('maybeReapIdleLoopVerify defers while Subagents are live', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!)
    _setTestLiveSubagents(true)
    const r = maybeReapIdleLoopVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(false)
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).not.toBeNull()
  })
})
