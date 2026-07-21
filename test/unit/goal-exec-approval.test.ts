// Active /goal + agim_exec → explicit HITL approval (not hard-block).
// Needs better-sqlite3; Bun skips, Node suite sets AGIM_TEST_REQUIRE_SQLITE=1.

import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-goal-exec-approval-'))
process.env.AGIM_HOME = TEST_HOME
process.env.AGIM_GOALS_DB = join(TEST_HOME, 'goals.db')

const {
  approvalBus,
  threadKey: makeThreadKey,
} = await import('../../src/core/approval-bus.js')
type ApprovalNotification = import('../../src/core/approval-bus.js').ApprovalNotification
const { _truncateForTests, setActiveGoal } = await import('../../src/core/goals.js')
const { buildPiApprovalGate } = await import('../../src/plugins/agents/agim-agent/approval.js')

const describeSqlite = process.env.AGIM_TEST_REQUIRE_SQLITE === '1' ? describe : describe.skip

const savedMode = process.env.AGIM_NATIVE_AGENT_MODE
const savedDeny = process.env.AGIM_NATIVE_AGENT_DENYLIST
const savedAuto = process.env.AGIM_AUTO_APPROVE
const savedTimeout = process.env.AGIM_TIMEOUT_DEFAULT

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

afterEach(async () => {
  if (savedMode === undefined) delete process.env.AGIM_NATIVE_AGENT_MODE
  else process.env.AGIM_NATIVE_AGENT_MODE = savedMode
  if (savedDeny === undefined) delete process.env.AGIM_NATIVE_AGENT_DENYLIST
  else process.env.AGIM_NATIVE_AGENT_DENYLIST = savedDeny
  if (savedAuto === undefined) delete process.env.AGIM_AUTO_APPROVE
  else process.env.AGIM_AUTO_APPROVE = savedAuto
  if (savedTimeout === undefined) delete process.env.AGIM_TIMEOUT_DEFAULT
  else process.env.AGIM_TIMEOUT_DEFAULT = savedTimeout
  approvalBus.setNotifier(null)
  await approvalBus.stop().catch(() => {})
  try { _truncateForTests() } catch { /* ignore */ }
})

describeSqlite('goal-scoped agim_exec approval', () => {
  it('allows agim_exec under an active goal when no notifier is wired (CI)', async () => {
    _truncateForTests()
    process.env.AGIM_NATIVE_AGENT_MODE = 'allow-list'
    delete process.env.AGIM_NATIVE_AGENT_DENYLIST
    const goal = setActiveGoal({
      platform: 'telegram',
      channelId: 'c1',
      threadId: 'goal-exec-ci',
      userId: 'u1',
      title: 'long-lived mission',
    })
    if (!goal) throw new Error('goal unavailable')
    const gate = buildPiApprovalGate({
      platform: 'telegram',
      channelId: 'c1',
      threadId: 'goal-exec-ci',
      userId: 'u1',
    }, 'session-goal-ci')
    expect(await gate(
      { id: 'e1', name: 'agim_exec', arguments: { command: 'npm test' } },
      0,
    )).toBe('allow')
  })

  it('forces an explicit HITL card for agim_exec under an active goal even when auto-approve is on', async () => {
    _truncateForTests()
    process.env.AGIM_NATIVE_AGENT_MODE = 'allow-all'
    process.env.AGIM_AUTO_APPROVE = '1'
    process.env.AGIM_TIMEOUT_DEFAULT = 'allow'
    delete process.env.AGIM_NATIVE_AGENT_DENYLIST
    const unique = `goal-exec-${Date.now()}`
    const key = makeThreadKey('telegram', 'c1', unique)
    const goal = setActiveGoal({
      platform: 'telegram',
      channelId: 'c1',
      threadId: unique,
      userId: 'u1',
      title: 'ship over many days',
    })
    if (!goal) throw new Error('goal unavailable')

    let notification: ApprovalNotification | undefined
    approvalBus.setNotifier(async (n) => { notification = n })

    const gate = buildPiApprovalGate({
      platform: 'telegram',
      channelId: 'c1',
      threadId: unique,
      userId: 'u1',
    }, `session-${unique}`)

    let settled = false
    const decisionPromise = gate(
      { id: 'e2', name: 'agim_exec', arguments: { command: 'nohup worker &' } },
      0,
    ).then((d) => {
      settled = true
      return d
    })

    for (let i = 0; i < 40 && !approvalBus.hasPendingFor(key); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(settled).toBe(false)
    expect(notification?.requiresExplicitDecision).toBe(true)
    expect(notification?.toolName).toBe('agim_exec')
    expect(Array.isArray(notification?.input?._goalExecNotes)).toBe(true)

    approvalBus.resolvePending(key, { behavior: 'allow' }, 'u1')
    expect(await decisionPromise).toBe('allow')
  })

  it('still honors deny-list for goal-scoped exec', async () => {
    _truncateForTests()
    process.env.AGIM_NATIVE_AGENT_MODE = 'allow-list'
    process.env.AGIM_NATIVE_AGENT_DENYLIST = 'agim_exec'
    const unique = `goal-deny-${Date.now()}`
    const goal = setActiveGoal({
      platform: 'telegram',
      channelId: 'c1',
      threadId: unique,
      userId: 'u1',
      title: 'denied exec',
    })
    if (!goal) throw new Error('goal unavailable')
    approvalBus.setNotifier(async () => {})
    const gate = buildPiApprovalGate({
      platform: 'telegram',
      channelId: 'c1',
      threadId: unique,
      userId: 'u1',
    }, `session-${unique}`)
    expect(await gate(
      { id: 'e3', name: 'agim_exec', arguments: { command: 'echo hi' } },
      0,
    )).toBe('deny')
  })
})
