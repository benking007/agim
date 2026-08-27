// ApprovalBus.registerSyntheticPending — P2 bridge surface tests.
//
// The synthetic path exists for transports that aren't unix-socket sidecars
// (opencode HTTP, future MCP-over-HTTP backends). Behavior parity with the
// socket path is the contract: same notifier, same timeout, same auto-allow,
// same resolvePending entry. The only thing that differs is *delivery* —
// caller's `dispatch(decision)` callback replaces socket writes.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ApprovalBus, threadKey, type ApprovalNotification, type Decision } from './approval-bus.js'

const RUN_CTX = { threadId: 'thread-A', platform: 'feishu', userId: 'u', channelId: 'c' }
const KEY = threadKey(RUN_CTX.platform, RUN_CTX.channelId, RUN_CTX.threadId)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('ApprovalBus.registerSyntheticPending', () => {
  let bus: ApprovalBus
  let savedAutoApprove: string | undefined
  let savedTimeoutDefault: string | undefined

  beforeEach(() => {
    savedAutoApprove = process.env.AGIM_AUTO_APPROVE
    savedTimeoutDefault = process.env.AGIM_TIMEOUT_DEFAULT
    process.env.AGIM_AUTO_APPROVE = '0'
    process.env.AGIM_TIMEOUT_DEFAULT = 'deny'
    bus = new ApprovalBus({ approvalTimeoutMs: 200, autoAllowGraceMs: 80 })
  })

  afterEach(() => {
    if (savedAutoApprove === undefined) delete process.env.AGIM_AUTO_APPROVE
    else process.env.AGIM_AUTO_APPROVE = savedAutoApprove
    if (savedTimeoutDefault === undefined) delete process.env.AGIM_TIMEOUT_DEFAULT
    else process.env.AGIM_TIMEOUT_DEFAULT = savedTimeoutDefault
  })

  afterEach(async () => {
    await bus.stop().catch(() => {})
  })

  it('Subagent callDepth>0 proxy-approves without IM card (even when AUTO_APPROVE=0)', async () => {
    const notifications: ApprovalNotification[] = []
    bus.setNotifier(async (n) => { notifications.push(n) })
    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'sub-1',
      reqId: 'sub-perm-1',
      toolName: 'Bash',
      input: { command: 'echo hi' },
      ctx: { ...RUN_CTX, callDepth: 1, callerAgent: 'agim' },
      dispatch: (d) => { decisions.push(d) },
    })
    expect(notifications).toHaveLength(0)
    expect(decisions).toEqual([{ behavior: 'allow' }])
    expect(bus.hasPendingFor(KEY)).toBe(false)
  })

  it('happy path: notifier fires, resolve(allow) dispatches once', async () => {
    const notifications: ApprovalNotification[] = []
    bus.setNotifier(async (n) => { notifications.push(n) })

    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-ses-1',
      reqId: 'perm-1',
      toolName: 'external_directory',
      input: { patterns: ['/root/workspace/agim/*'] },
      ctx: RUN_CTX,
      dispatch: (d) => { decisions.push(d) },
    })

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.toolName).toBe('external_directory')
    expect(notifications[0]?.input).toEqual({ patterns: ['/root/workspace/agim/*'] })
    expect(notifications[0]?.ctx.threadId).toBe('thread-A')
    expect(bus.hasPendingFor(KEY)).toBe(true)

    bus.resolvePending(KEY, { behavior: 'allow' })
    expect(decisions.length).toBe(1)
    expect(decisions[0]).toEqual({ behavior: 'allow' })
    expect(bus.hasPendingFor(KEY)).toBe(false)
  })

  it('explicit-decision requests bypass auto-approve and cannot seed remembered rules', async () => {
    process.env.AGIM_AUTO_APPROVE = '1'
    process.env.AGIM_TIMEOUT_DEFAULT = 'allow'
    const notifications: ApprovalNotification[] = []
    bus.setNotifier(async (n) => { notifications.push(n) })
    const decisions: Decision[] = []

    await bus.registerSyntheticPending({
      runId: 'plan-1',
      reqId: 'plan-exit-1',
      toolName: 'agim_exit_plan_mode',
      input: { plan: '- step' },
      requiresExplicitDecision: true,
      ctx: RUN_CTX,
      dispatch: (d) => decisions.push(d),
    })

    expect(notifications[0]?.requiresExplicitDecision).toBe(true)
    expect(decisions).toEqual([])
    expect(bus.hasPendingFor(KEY)).toBe(true)

    expect(bus.resolvePending(KEY, { behavior: 'allow' }, 'other-user')).toBeNull()
    expect(bus.hasPendingFor(KEY)).toBe(true)
    bus.resolvePending(KEY, { behavior: 'allow', autoAllowFurther: true }, RUN_CTX.userId)
    expect(decisions).toEqual([{ behavior: 'allow' }])
    expect(bus.getAutoAllowKeys(KEY)).toEqual([])
  })

  it('logged-in web actor web:<thread> cannot resolve plan-exit stamped with account id', async () => {
    const notifications: ApprovalNotification[] = []
    bus.setNotifier(async (n) => { notifications.push(n) })
    const decisions: Decision[] = []
    const accountId = 'usr_alice'
    const threadId = 'web-threadbbbb'
    const webAnon = `web:${threadId}`

    await bus.registerSyntheticPending({
      runId: 'plan-web-1',
      reqId: 'plan-exit-web-1',
      toolName: 'agim_exit_plan_mode',
      input: { plan: '- implement' },
      requiresExplicitDecision: true,
      ctx: { ...RUN_CTX, threadId, userId: accountId, platform: 'web', channelId: 'web' },
      dispatch: (d) => decisions.push(d),
    })

    const key = threadKey('web', 'web', threadId)
    expect(bus.resolvePendingByReqId('plan-exit-web-1', { behavior: 'allow' }, webAnon)).toBeNull()
    expect(bus.resolvePendingByReqId('plan-exit-web-1', { behavior: 'allow' })).toBeNull()
    expect(decisions).toEqual([])
    expect(bus.hasPendingFor(key)).toBe(true)

    bus.resolvePendingByReqId('plan-exit-web-1', { behavior: 'allow' }, accountId)
    expect(decisions).toEqual([{ behavior: 'allow' }])
    expect(notifications[0]?.requiresExplicitDecision).toBe(true)
  })

  it('explicit-decision requests deny on timeout even when timeout default is allow', async () => {
    process.env.AGIM_AUTO_APPROVE = '1'
    process.env.AGIM_TIMEOUT_DEFAULT = 'allow'
    bus.setNotifier(async () => {})
    const decisions: Decision[] = []

    await bus.registerSyntheticPending({
      runId: 'plan-2',
      reqId: 'plan-exit-2',
      toolName: 'agim_exit_plan_mode',
      input: { plan: '- step' },
      requiresExplicitDecision: true,
      ctx: RUN_CTX,
      dispatch: (d) => decisions.push(d),
    })

    await sleep(300)
    expect(decisions).toEqual([{ behavior: 'deny', message: 'explicit approval timeout' }])
  })

  it('pinnable explicit: 替我审批 (AGIM_AUTO_APPROVE) auto-allows without a card', async () => {
    process.env.AGIM_AUTO_APPROVE = '1'
    const notifications: ApprovalNotification[] = []
    bus.setNotifier(async (n) => { notifications.push(n) })
    const decisions: Decision[] = []

    await bus.registerSyntheticPending({
      runId: 'exec-aa-1',
      reqId: 'unconfined-aa-1',
      toolName: 'agim_exec',
      input: { command: 'curl -s http://example.com/a' },
      requiresExplicitDecision: true,
      allowSessionPin: true,
      ctx: RUN_CTX,
      dispatch: (d) => decisions.push(d),
    })
    expect(notifications).toEqual([])
    expect(decisions).toEqual([{ behavior: 'allow' }])
    expect(bus.hasPendingFor(KEY)).toBe(false)
  })

  it('pinnable explicit: Auto-for-similar seeds a rule; next match enters grace', async () => {
    process.env.AGIM_AUTO_APPROVE = '0' // session pin path (no global auto-approve)
    const notifications: ApprovalNotification[] = []
    bus.setNotifier(async (n) => { notifications.push(n) })
    const decisions: Decision[] = []

    await bus.registerSyntheticPending({
      runId: 'exec-1',
      reqId: 'unconfined-1',
      toolName: 'agim_exec',
      input: { command: 'curl -s http://example.com/a' },
      requiresExplicitDecision: true,
      allowSessionPin: true,
      ctx: RUN_CTX,
      dispatch: (d) => decisions.push(d),
    })
    expect(notifications[0]?.requiresExplicitDecision).toBe(true)
    expect(notifications[0]?.allowSessionPin).toBe(true)
    expect(notifications[0]?.autoAllow).toBeUndefined()

    bus.resolvePending(KEY, { behavior: 'allow', autoAllowFurther: true }, RUN_CTX.userId)
    expect(decisions).toEqual([{ behavior: 'allow', autoAllowFurther: true }])
    expect(bus.getAutoAllowKeys(KEY).length).toBe(1)

    const decisions2: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'exec-2',
      reqId: 'unconfined-2',
      toolName: 'agim_exec',
      input: { command: 'curl -s http://example.com/b' },
      requiresExplicitDecision: true,
      allowSessionPin: true,
      ctx: RUN_CTX,
      dispatch: (d) => decisions2.push(d),
    })
    expect(notifications[1]?.autoAllow).toEqual({ graceMs: 80 })
    await sleep(150)
    expect(decisions2).toEqual([{ behavior: 'allow' }])
  })

  it('pinnable explicit: long timeoutMs override does not stretch auto-allow grace', async () => {
    // Regression: confirmUnconfinedGoalExec always passes a multi-minute
    // timeoutMs. Once a session pin exists, that override used to win over
    // autoAllowGraceMs — SPA hit "Auto-allowing now…" while the bus waited.
    const notifications: ApprovalNotification[] = []
    bus.setNotifier(async (n) => { notifications.push(n) })
    const decisions: Decision[] = []

    await bus.registerSyntheticPending({
      runId: 'exec-long-1',
      reqId: 'unconfined-long-1',
      toolName: 'agim_exec',
      input: { command: 'curl -s http://example.com/pin' },
      requiresExplicitDecision: true,
      allowSessionPin: true,
      timeoutMs: 30 * 60 * 1000,
      ctx: RUN_CTX,
      dispatch: (d) => decisions.push(d),
    })
    bus.resolvePending(KEY, { behavior: 'allow', autoAllowFurther: true }, RUN_CTX.userId)
    expect(decisions).toEqual([{ behavior: 'allow', autoAllowFurther: true }])

    const decisions2: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'exec-long-2',
      reqId: 'unconfined-long-2',
      toolName: 'agim_exec',
      input: { command: 'curl -s http://example.com/pin2' },
      requiresExplicitDecision: true,
      allowSessionPin: true,
      timeoutMs: 30 * 60 * 1000,
      ctx: RUN_CTX,
      dispatch: (d) => decisions2.push(d),
    })
    expect(notifications[1]?.autoAllow).toEqual({ graceMs: 80 })
    await sleep(150)
    expect(decisions2).toEqual([{ behavior: 'allow' }])
  })

  it('lifecycle cancellation preserves a non-user resolution cause', async () => {
    bus.setNotifier(async () => {})
    const causes: string[] = []
    bus.setResolutionListener((event) => { causes.push(event.cause) })
    await bus.registerSyntheticPending({
      runId: 'cancel-1',
      reqId: 'cancel-pending-1',
      toolName: 'agim_exec',
      input: { command: 'sleep 10' },
      ctx: RUN_CTX,
      dispatch: () => {},
    })

    expect(bus.cancelPendingByReqId('cancel-pending-1', 'turn aborted')).toBe(true)
    expect(causes).toEqual(['run-terminated'])
    expect(bus.hasPendingFor(KEY)).toBe(false)
  })

  it('resolve(deny) forwards the message via dispatch', async () => {
    bus.setNotifier(async () => {})
    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-1', toolName: 'bash', input: { command: 'rm -rf /' },
      ctx: RUN_CTX, dispatch: (d) => decisions.push(d),
    })

    bus.resolvePending(KEY, { behavior: 'deny', message: 'hard no' })
    expect(decisions[0]).toEqual({ behavior: 'deny', message: 'hard no' })
  })

  it('timeout in normal mode dispatches deny("approval timeout")', async () => {
    bus.setNotifier(async () => {})
    const decisions: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-1', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => decisions.push(d),
    })

    await sleep(300)
    expect(decisions.length).toBe(1)
    expect(decisions[0].behavior).toBe('deny')
    if (decisions[0].behavior === 'deny') {
      expect(decisions[0].message).toBe('approval timeout')
    }
    expect(bus.hasPendingFor(KEY)).toBe(false)
  })

  it('auto-allow grace mode: timer expiry dispatches allow', async () => {
    // Pre-seed the rule by going through the bus's user-allow+all path.
    bus.setNotifier(async () => {})
    const firstDispatched: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-seed', toolName: 't',
      input: { command: 'git status' },
      ctx: RUN_CTX, dispatch: (d) => firstDispatched.push(d),
    })
    bus.resolvePending(KEY, { behavior: 'allow', autoAllowFurther: true })
    expect(firstDispatched[0]).toEqual({ behavior: 'allow', autoAllowFurther: true })

    // Now a second call with the same fingerprint enters auto-allow mode.
    // "git status" and "git status -s" share the 10-char prefix `git status`
    // (M13: AUTO_ALLOW_PREFIX_LEN bumped 5 → 10).
    const secondDispatched: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-2', toolName: 't',
      input: { command: 'git status -s' },
      ctx: RUN_CTX, dispatch: (d) => secondDispatched.push(d),
    })

    // Grace timer expires → bus auto-resolves to allow without user input.
    await sleep(150)
    expect(secondDispatched.length).toBe(1)
    expect(secondDispatched[0].behavior).toBe('allow')
  })

  it('auto-allow user-deny path revokes the rule', async () => {
    bus.setNotifier(async () => {})
    const seeded: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-seed', toolName: 't',
      input: { command: 'git status' },
      ctx: RUN_CTX, dispatch: (d) => seeded.push(d),
    })
    bus.resolvePending(KEY, { behavior: 'allow', autoAllowFurther: true })
    expect(bus.getAutoAllowKeys(KEY).length).toBe(1)

    // Second call enters grace mode, user explicitly denies → revoke.
    const second: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-2', toolName: 't',
      input: { command: 'git status' },
      ctx: RUN_CTX, dispatch: (d) => second.push(d),
    })
    const info = bus.resolvePending(KEY, { behavior: 'deny' })
    expect(info?.wasAutoAllow).toBe(true)
    expect(second[0].behavior).toBe('deny')
    expect(bus.getAutoAllowKeys(KEY).length).toBe(0)
  })

  it('throws when no notifier is installed (caller falls back)', async () => {
    let threw = false
    try {
      await bus.registerSyntheticPending({
        runId: 'oc-1', reqId: 'perm-1', toolName: 't', input: {},
        ctx: RUN_CTX, dispatch: () => {},
      })
    } catch (err) {
      threw = true
      expect(String(err)).toContain('no notifier installed')
    }
    expect(threw).toBe(true)
  })

  it('duplicate reqId is dropped silently — first pending wins', async () => {
    let notifyCount = 0
    bus.setNotifier(async () => { notifyCount++ })

    const first: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-dup', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => first.push(d),
    })

    const second: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-dup', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => second.push(d),
    })

    expect(notifyCount).toBe(1)
    bus.resolvePending(KEY, { behavior: 'allow' })
    expect(first.length).toBe(1)
    expect(second.length).toBe(0)  // duplicate dispatch never fired
  })

  it('dispatch errors are isolated (bus keeps working)', async () => {
    bus.setNotifier(async () => {})
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-bad', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: () => { throw new Error('boom') },
    })

    // Should NOT throw despite dispatch's rejection.
    bus.resolvePending(KEY, { behavior: 'allow' })
    expect(bus.hasPendingFor(KEY)).toBe(false)

    // A subsequent registration in the same thread still works.
    const next: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-1', reqId: 'perm-next', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => next.push(d),
    })
    bus.resolvePending(KEY, { behavior: 'allow' })
    expect(next.length).toBe(1)
  })

  it('unregisterRun denies all synthetic pendings tied to that runId', async () => {
    bus.setNotifier(async () => {})
    const dispatched: Decision[] = []
    await bus.registerSyntheticPending({
      runId: 'oc-ses-1', reqId: 'p-1', toolName: 't', input: {},
      ctx: RUN_CTX, dispatch: (d) => dispatched.push(d),
    })

    bus.unregisterRun('oc-ses-1')
    expect(dispatched.length).toBe(1)
    expect(dispatched[0].behavior).toBe('deny')
    if (dispatched[0].behavior === 'deny') {
      expect(dispatched[0].message).toBe('run terminated')
    }
  })
})
