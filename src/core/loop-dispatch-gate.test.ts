import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  evaluateLoopDispatchGate,
  isLoopDispatchGateExemptTool,
  isLoopDispatchGateOn,
} from './loop-dispatch-gate.js'
import { noteLoopDispatch, startLoop, stopLoop } from './loop-run.js'
import { setFocus } from './focus.js'

describe('loop dispatch gate', () => {
  let dir: string
  const prevLoops = process.env.AGIM_LOOPS_DIR
  const prevGate = process.env.AGIM_LOOP_DISPATCH_GATE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-dispatch-gate-'))
    process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
    delete process.env.AGIM_LOOP_DISPATCH_GATE
  })

  afterEach(() => {
    if (prevLoops === undefined) delete process.env.AGIM_LOOPS_DIR
    else process.env.AGIM_LOOPS_DIR = prevLoops
    if (prevGate === undefined) delete process.env.AGIM_LOOP_DISPATCH_GATE
    else process.env.AGIM_LOOP_DISPATCH_GATE = prevGate
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('reads AGIM_LOOP_DISPATCH_GATE', () => {
    process.env.AGIM_LOOP_DISPATCH_GATE = 'off'
    expect(isLoopDispatchGateOn()).toBe(false)
    process.env.AGIM_LOOP_DISPATCH_GATE = 'on'
    expect(isLoopDispatchGateOn()).toBe(true)
    delete process.env.AGIM_LOOP_DISPATCH_GATE
    expect(isLoopDispatchGateOn()).toBe(true)
  })

  it('exempts call_agents / todo / ask_user', () => {
    expect(isLoopDispatchGateExemptTool('mcp__agim__call_agents')).toBe(true)
    expect(isLoopDispatchGateExemptTool('call_agent')).toBe(true)
    expect(isLoopDispatchGateExemptTool('agim_todo_write')).toBe(true)
    expect(isLoopDispatchGateExemptTool('mcp__agim__ask_user')).toBe(true)
    expect(isLoopDispatchGateExemptTool('mcp__agim__loop_verdict')).toBe(true)
    expect(isLoopDispatchGateExemptTool('agim_web_fetch')).toBe(false)
    expect(isLoopDispatchGateExemptTool('agim_exec')).toBe(false)
  })

  it('blocks parent web_fetch until first dispatch; allows after', () => {
    // Seed a planning Loop via JSON so Bun (no better-sqlite3 Focus) still exercises the gate.
    const platform = 'web'
    const channelId = 'web'
    const threadId = `t-gate-${Date.now()}`
    const now = Date.now()
    const sessionKey = `${platform}__${channelId}__${threadId}`
    mkdirSync(process.env.AGIM_LOOPS_DIR!, { recursive: true, mode: 0o700 })
    writeFileSync(join(process.env.AGIM_LOOPS_DIR!, `${sessionKey}.json`), JSON.stringify({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      sessionKey,
      platform,
      channelId,
      threadId,
      focusSnapshot: '修好登录',
      openedFocus: false,
      status: 'planning',
      round: 1,
      maxRounds: 3,
      mission: {
        objective: '修好登录',
        exit: { description: '验收通过', maxRounds: 3, onFocusOff: 'cancel' },
      },
      dispatchesThisRound: 0,
      usage: { dispatchCount: 0, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
      createdAt: now,
      updatedAt: now,
      timeline: [],
    }), 'utf8')

    const blocked = evaluateLoopDispatchGate(platform, channelId, threadId, 'agim_web_fetch')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toContain('loop-dispatch-gate')

    const spawnOk = evaluateLoopDispatchGate(
      platform, channelId, threadId, 'mcp__agim__call_agents',
    )
    expect(spawnOk.ok).toBe(true)

    noteLoopDispatch(platform, channelId, threadId, {
      tasks: [{ id: '1', brief: 'do work', agentHint: 'agim/cheap' }],
    })

    const after = evaluateLoopDispatchGate(platform, channelId, threadId, 'agim_web_fetch')
    expect(after.ok).toBe(true)

    stopLoop(platform, channelId, threadId, 'user_stop')
  })

  it('no-ops without active loop', () => {
    const r = evaluateLoopDispatchGate('web', 'web', 'no-loop-thread', 'agim_web_fetch')
    expect(r.ok).toBe(true)
  })

  it('can be disabled via env', () => {
    process.env.AGIM_LOOP_DISPATCH_GATE = 'off'
    const platform = 'web'
    const channelId = 'web'
    const threadId = `t-off-${Date.now()}`
    setFocus({
      platform, channelId, threadId, userId: 'u',
      title: 'x',
    })
    startLoop({
      platform, channelId, threadId, userId: 'u',
      text: '目标；退出条件为验收通过',
    })
    const r = evaluateLoopDispatchGate(platform, channelId, threadId, 'agim_web_fetch')
    expect(r.ok).toBe(true)
    stopLoop(platform, channelId, threadId, 'user_stop')
  })
})
