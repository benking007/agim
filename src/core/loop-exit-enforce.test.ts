import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  forceLoopExitSkippedVerify,
  getActiveLoop,
  maybeEnforceLoopExit,
} from './loop-run.js'

function seed(dir: string, over: Record<string, unknown> = {}) {
  const platform = 'web'
  const channelId = 'web'
  const threadId = `t-exit-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
  const sessionKey = `${platform}__${channelId}__${threadId}`
  const now = Date.now()
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
    ...over.fields,
  }), 'utf8')
  return { platform, channelId, threadId }
}

describe('loop exit enforce (no verdict required)', () => {
  let dir: string
  const prev = process.env.AGIM_LOOPS_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-exit-'))
    process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
  })

  afterEach(() => {
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

  it('forceLoopExitSkippedVerify ends as verify_skipped', () => {
    const a = seed(process.env.AGIM_LOOPS_DIR!)
    const r = forceLoopExitSkippedVerify(a.platform, a.channelId, a.threadId)
    expect(r.ended).toBe(true)
    expect(r.reason).toBe('verify_skipped')
    expect(r.run?.endReason).toBe('verify_skipped')
    expect(getActiveLoop(a.platform, a.channelId, a.threadId)).toBeNull()
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
})
