// v1.2.131 P0b — agim_exit_plan_mode dispatcher.
//
// Pins:
//   (a) refuses calls when plan mode is NOT on for the thread
//   (b) validates `plan` arg (must be non-empty string, ≤ 4000 chars)
//   (c) refuses without IM notifier — degrades to error result, no
//       attempt to register with approvalBus (CLI / headless safety)
//   (d) tool def shape — single string `plan` arg, plan-exit timeoutMs
//
// Note: the approve/reject branches require a live approvalBus +
// notifier, which we can't easily stand up in a unit test. Those
// paths are exercised at integration time. Here we cover the input
// gates that fail fast BEFORE the bus is involved.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import type { ToolCallRequest } from '../../src/core/llm/provider-base.js'
import { approvalBus, threadKey as makeThreadKey, type ApprovalNotification } from '../../src/core/approval-bus.js'
import { sessionManager } from '../../src/core/session.js'
import {
  buildPlanExitDispatcher,
  getPlanExitTools,
  isPlanExitToolName,
  PLAN_EXIT_TOOL_NAME,
} from '../../src/core/llm/plan-exit-dispatcher.js'

/** Tests always pass an AbortSignal — the dispatcher signature
 *  requires it, even though plan-exit doesn't honour mid-flight
 *  cancellation (the approval-bus owns timeout semantics). */
const SIGNAL = new AbortController().signal

describe('plan-exit-dispatcher — tool def + name helper', () => {
  it('PLAN_EXIT_TOOL_NAME matches isPlanExitToolName', () => {
    expect(isPlanExitToolName(PLAN_EXIT_TOOL_NAME)).toBe(true)
    expect(isPlanExitToolName('agim_todo_write')).toBe(false)
    expect(isPlanExitToolName('')).toBe(false)
  })

  it('getPlanExitTools advertises exactly one tool with `plan` string arg', () => {
    const defs = getPlanExitTools()
    expect(defs).toHaveLength(1)
    const t = defs[0]
    expect(t.name).toBe('agim_exit_plan_mode')
    expect(t.parameters.type).toBe('object')
    expect(t.parameters.required).toEqual(['plan'])
    const planProp = (t.parameters.properties as Record<string, { type: string }>).plan
    expect(planProp.type).toBe('string')
    // Generous timeout — approval card may wait for the operator.
    expect(t.timeoutMs).toBeGreaterThan(60_000)
  })
})

describe('plan-exit-dispatcher — input gates (v1.2.131 P0b)', () => {
  const saved = process.env.AGIM_NATIVE_PLAN_MODE
  beforeEach(() => { delete process.env.AGIM_NATIVE_PLAN_MODE })
  afterEach(() => {
    if (saved === undefined) delete process.env.AGIM_NATIVE_PLAN_MODE
    else process.env.AGIM_NATIVE_PLAN_MODE = saved
  })

  function makeDispatcher(opts: Partial<{ threadKey: string; platform: string; threadId: string }> = {}) {
    return buildPlanExitDispatcher({
      threadKey: opts.threadKey ?? 'tg:test:thread1',
      runId: 'run-xyz',
      platform: opts.platform ?? 'telegram',
      channelId: 'c1',
      threadId: opts.threadId ?? 'thread1',
      userId: 'u1',
    })
  }

  function call(name: string, args: Record<string, unknown>): ToolCallRequest {
    return { id: 't1', name, arguments: args }
  }

  it('refuses when called outside plan mode', async () => {
    const d = makeDispatcher()
    const r = await d(call('agim_exit_plan_mode', { plan: 'some plan' }), SIGNAL)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/can only be called while Plan Mode is active/i)
  })

  it('returns unknown for a different tool name', async () => {
    const d = makeDispatcher()
    const r = await d(call('agim_todo_write', {}), SIGNAL)
    expect(r.isError).toBe(true)
    expect(r.source).toBe('unknown')
  })

  it('refuses missing or non-string plan arg (env=ON so plan-mode-on)', async () => {
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    const d = makeDispatcher()
    const r1 = await d(call('agim_exit_plan_mode', {}), SIGNAL)
    expect(r1.isError).toBe(true)
    expect(r1.text).toMatch(/plan/i)
    const r2 = await d(call('agim_exit_plan_mode', { plan: 42 }), SIGNAL)
    expect(r2.isError).toBe(true)
    expect(r2.text).toMatch(/must be a string/i)
  })

  it('refuses empty plan after trim', async () => {
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    const d = makeDispatcher()
    const r = await d(call('agim_exit_plan_mode', { plan: '   \n  ' }), SIGNAL)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/empty/i)
  })

  it('refuses plan over 4000 chars', async () => {
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    const d = makeDispatcher()
    const r = await d(call('agim_exit_plan_mode', { plan: 'x'.repeat(5000) }), SIGNAL)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/too long/i)
  })

  it('degrades cleanly when no IM context provided', async () => {
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    // Build with no platform / threadId — simulates CLI / smoke.
    const d = buildPlanExitDispatcher({
      threadKey: 'tg:test:thread1',
      runId: 'run-headless',
    })
    const r = await d(call('agim_exit_plan_mode', { plan: '- step 1\n- step 2' }), SIGNAL)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/no interactive ui/i)
  })

  it('requires a real user decision even when global auto-approve is enabled', async () => {
    const savedAuto = process.env.AGIM_AUTO_APPROVE
    const savedTimeout = process.env.AGIM_TIMEOUT_DEFAULT
    const unique = `plan-explicit-${Date.now()}`
    const key = makeThreadKey('telegram', 'c1', unique)
    let notification: ApprovalNotification | undefined
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    process.env.AGIM_AUTO_APPROVE = '1'
    process.env.AGIM_TIMEOUT_DEFAULT = 'allow'
    approvalBus.setNotifier(async (n) => { notification = n })
    try {
      await sessionManager.getOrCreateSession('telegram', 'c1', unique, 'native')
      await sessionManager.patchSession('telegram', 'c1', unique, { planMode: true })
      const d = buildPlanExitDispatcher({
        threadKey: key,
        runId: `run-${unique}`,
        platform: 'telegram',
        channelId: 'c1',
        threadId: unique,
        userId: 'u1',
      })
      let settled = false
      const resultPromise = d(
        call('agim_exit_plan_mode', { plan: '- implement only after approval' }),
        SIGNAL,
      ).then((result) => {
        settled = true
        return result
      })

      for (let i = 0; i < 20 && !approvalBus.hasPendingFor(key); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(settled).toBe(false)
      expect(notification?.requiresExplicitDecision).toBe(true)
      approvalBus.resolvePending(key, { behavior: 'allow' }, 'u1')
      const result = await resultPromise
      expect(result.isError).toBe(false)
      expect(result.text).toContain('approved by user')
      expect((await sessionManager.getExistingSession('telegram', 'c1', unique))?.planMode).toBeUndefined()
    } finally {
      approvalBus.setNotifier(null)
      await approvalBus.stop()
      if (savedAuto === undefined) delete process.env.AGIM_AUTO_APPROVE
      else process.env.AGIM_AUTO_APPROVE = savedAuto
      if (savedTimeout === undefined) delete process.env.AGIM_TIMEOUT_DEFAULT
      else process.env.AGIM_TIMEOUT_DEFAULT = savedTimeout
    }
  })

  it('cancels the pending approval when the agent turn is aborted', async () => {
    const savedAuto = process.env.AGIM_AUTO_APPROVE
    const unique = `plan-abort-${Date.now()}`
    const key = makeThreadKey('telegram', 'c1', unique)
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    process.env.AGIM_AUTO_APPROVE = '1'
    approvalBus.setNotifier(async () => {})
    const ctrl = new AbortController()
    try {
      const d = buildPlanExitDispatcher({
        threadKey: key,
        runId: `run-${unique}`,
        platform: 'telegram',
        channelId: 'c1',
        threadId: unique,
        userId: 'u1',
      })
      const resultPromise = d(
        call('agim_exit_plan_mode', { plan: '- only after approval' }),
        ctrl.signal,
      )
      for (let i = 0; i < 20 && !approvalBus.hasPendingFor(key); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(approvalBus.hasPendingFor(key)).toBe(true)
      ctrl.abort()
      const result = await resultPromise
      expect(result.isError).toBe(true)
      expect(result.text).toContain('agent turn aborted')
      expect(approvalBus.hasPendingFor(key)).toBe(false)
    } finally {
      approvalBus.setNotifier(null)
      await approvalBus.stop()
      if (savedAuto === undefined) delete process.env.AGIM_AUTO_APPROVE
      else process.env.AGIM_AUTO_APPROVE = savedAuto
    }
  })
})
