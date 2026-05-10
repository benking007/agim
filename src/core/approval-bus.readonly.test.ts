// ApprovalBus readonly auto-allow — short-circuit tests.
//
// Contract: tools in the readonly allowlist (Read / Grep / Glob / LS /
// NotebookRead) must NEVER reach the IM notifier and must dispatch an
// immediate `allow` decision. Non-readonly tools must continue to flow
// through the normal pending → notifier → resolve cycle.
//
// All tests use the synthetic transport (dispatch callback) so they run
// without opening a unix socket.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  ApprovalBus,
  threadKey,
  type ApprovalNotification,
  type Decision,
} from './approval-bus.js'

const RUN_CTX = { threadId: 'thread-A', platform: 'feishu', userId: 'u', channelId: 'c' }
const KEY = threadKey(RUN_CTX.platform, RUN_CTX.channelId, RUN_CTX.threadId)

describe('ApprovalBus readonly auto-allow', () => {
  let bus: ApprovalBus
  let notifierCalls: ApprovalNotification[]

  beforeEach(() => {
    bus = new ApprovalBus({ approvalTimeoutMs: 200, autoAllowGraceMs: 80 })
    notifierCalls = []
    bus.setNotifier(async (n) => { notifierCalls.push(n) })
  })

  afterEach(async () => {
    await bus.stop().catch(() => {})
  })

  for (const tool of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) {
    it(`${tool}: short-circuits with immediate allow, no notifier`, async () => {
      const decisions: Decision[] = []
      await bus.registerSyntheticPending({
        runId: 'r1', reqId: `req-${tool}`, toolName: tool,
        input: { path: '/etc/hosts' },
        ctx: RUN_CTX,
        dispatch: (d) => { decisions.push(d) },
      })
      expect(decisions.length).toBe(1)
      expect(decisions[0]).toEqual({ behavior: 'allow' })
      expect(notifierCalls.length).toBe(0)
      // No pending should have been registered.
      expect(bus.hasPendingFor(KEY)).toBe(false)
      // Metrics counters bumped.
      const m = bus.getMetrics()
      expect(m.totalRequests).toBe(1)
      expect(m.totalAllowed).toBe(1)
      expect(m.totalReadonlyAutoAllowed).toBe(1)
    })
  }

  for (const tool of ['Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'mcp__github__create_issue']) {
    it(`${tool}: still flows to notifier (not in readonly list)`, async () => {
      const decisions: Decision[] = []
      await bus.registerSyntheticPending({
        runId: 'r1', reqId: `req-${tool}`, toolName: tool, input: { x: 1 },
        ctx: RUN_CTX,
        dispatch: (d) => { decisions.push(d) },
      })
      expect(decisions.length).toBe(0) // not yet resolved
      expect(notifierCalls.length).toBe(1)
      expect(notifierCalls[0].toolName).toBe(tool)
      expect(bus.hasPendingFor(KEY)).toBe(true)
    })
  }

  it('per-thread opt-out: readonly tools fall through to notifier when disabled', async () => {
    bus.setReadonlyAutoAllowEnabled(KEY, false)
    expect(bus.isReadonlyAutoAllowEnabled(KEY)).toBe(false)

    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'r1', reqId: 'req-1', toolName: 'Read',
      input: { path: '/etc/hosts' },
      ctx: RUN_CTX,
      dispatch: (d) => { decisions.push(d) },
    })
    expect(decisions.length).toBe(0)
    expect(notifierCalls.length).toBe(1)
    expect(bus.hasPendingFor(KEY)).toBe(true)
  })

  it('toggle on after off: subsequent readonly call short-circuits again', async () => {
    bus.setReadonlyAutoAllowEnabled(KEY, false)
    bus.setReadonlyAutoAllowEnabled(KEY, true)
    expect(bus.isReadonlyAutoAllowEnabled(KEY)).toBe(true)

    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'r1', reqId: 'req-2', toolName: 'Read', input: {},
      ctx: RUN_CTX,
      dispatch: (d) => { decisions.push(d) },
    })
    expect(decisions).toEqual([{ behavior: 'allow' }])
    expect(notifierCalls.length).toBe(0)
  })

  it('per-thread opt-out is scoped: thread B not affected by thread A opt-out', async () => {
    const ctxB = { ...RUN_CTX, threadId: 'thread-B' }
    const keyB = threadKey(ctxB.platform, ctxB.channelId, ctxB.threadId)

    bus.setReadonlyAutoAllowEnabled(KEY, false)
    expect(bus.isReadonlyAutoAllowEnabled(KEY)).toBe(false)
    expect(bus.isReadonlyAutoAllowEnabled(keyB)).toBe(true)

    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'r1', reqId: 'req-B', toolName: 'Read', input: {},
      ctx: ctxB,
      dispatch: (d) => { decisions.push(d) },
    })
    expect(decisions).toEqual([{ behavior: 'allow' }])
    expect(notifierCalls.length).toBe(0)
  })

  it('isReadonlyTool / getReadonlyTools surface the allowlist', () => {
    expect(bus.isReadonlyTool('Read')).toBe(true)
    expect(bus.isReadonlyTool('Grep')).toBe(true)
    expect(bus.isReadonlyTool('Bash')).toBe(false)
    expect(bus.isReadonlyTool('WebFetch')).toBe(false)
    const tools = bus.getReadonlyTools()
    expect(tools).toContain('Read')
    expect(tools).toContain('Grep')
    expect(tools).toContain('Glob')
    expect(tools).toContain('LS')
    expect(tools).toContain('NotebookRead')
    expect(tools).not.toContain('Bash')
  })

  it('stop() clears the per-thread opt-out set', async () => {
    bus.setReadonlyAutoAllowEnabled(KEY, false)
    expect(bus.isReadonlyAutoAllowEnabled(KEY)).toBe(false)
    await bus.stop()
    // Fresh bus state should default-on again.
    expect(bus.isReadonlyAutoAllowEnabled(KEY)).toBe(true)
  })
})
