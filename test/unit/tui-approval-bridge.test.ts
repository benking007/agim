import { afterEach, describe, expect, it } from 'bun:test'

import { TuiApprovalBridge } from '../../src/cli-ui/tui/approval-bridge'
import { approvalBus, type Decision } from '../../src/core/approval-bus'
import { handleAskOp, _resetAskBusForTests } from '../../src/core/ask-user-rpc'
import { registry } from '../../src/core/registry'
import {
  install as installApprovalRouter,
  uninstall as uninstallApprovalRouter,
} from '../../src/core/approval-router'

describe('TuiApprovalBridge', () => {
  afterEach(async () => {
    uninstallApprovalRouter()
    await approvalBus.stop()
    _resetAskBusForTests()
  })

  it('surfaces approval cards and resolves y as allow', async () => {
    const bridge = new TuiApprovalBridge('session-1')
    let latestMessageId: string | undefined
    let decision: Decision | undefined

    bridge.subscribe((approval) => {
      if (approval) latestMessageId = approval.messageId
    })

    installApprovalRouter({
      resolveMessenger: (platform) => platform === 'tui' ? bridge : undefined,
      buttonCallbackPlatforms: ['tui'],
    })

    await approvalBus.registerSyntheticPending({
      runId: 'run-1',
      reqId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      ctx: {
        platform: 'tui',
        channelId: 'local',
        threadId: 'session-1',
        userId: 'tester',
        callerAgent: 'native',
      },
      dispatch: (d) => { decision = d },
    })

    expect(latestMessageId).toStartWith('tui-approval-')
    expect(await bridge.submitText('y')).toBe(true)
    expect(decision).toEqual({ behavior: 'allow' })
  })

  it('resolves selected all option as auto-allow', async () => {
    const bridge = new TuiApprovalBridge('session-2')
    let decision: Decision | undefined

    installApprovalRouter({
      resolveMessenger: (platform) => platform === 'tui' ? bridge : undefined,
      buttonCallbackPlatforms: ['tui'],
    })

    await approvalBus.registerSyntheticPending({
      runId: 'run-2',
      reqId: 'req-2',
      toolName: 'Bash',
      input: { command: 'pwd' },
      ctx: {
        platform: 'tui',
        channelId: 'local',
        threadId: 'session-2',
        userId: 'tester',
        callerAgent: 'native',
      },
      dispatch: (d) => { decision = d },
    })

    expect(await bridge.submitChoice('a')).toBe(true)
    expect(decision).toEqual({ behavior: 'allow', autoAllowFurther: true })
    expect(approvalBus.getAutoAllowKeys('tui:local:session-2')).toHaveLength(1)
  })

  it('surfaces ask cards and resolves single-select by text', async () => {
    const bridge = new TuiApprovalBridge('session-ask-1')
    registry.registerMessenger(bridge)
    let latestReqId: string | undefined

    bridge.subscribeAsk((ask) => {
      if (ask) latestReqId = ask.reqId
    })

    installApprovalRouter({
      resolveMessenger: (platform) => platform === 'tui' ? bridge : undefined,
      buttonCallbackPlatforms: ['tui'],
    })

    const ask = handleAskOp({
      question: 'Pick one',
      choices: ['A', 'B'],
    }, {
      platform: 'tui',
      channelId: 'local',
      threadId: 'session-ask-1',
      userId: 'tester',
    })

    await new Promise<void>((r) => setImmediate(r))
    expect(latestReqId).toBeTruthy()
    expect(await bridge.submitAskText('2')).toBe(true)
    const result = await ask
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.index).toBe(2)
      expect(result.result.label).toBe('B')
      expect(result.result.selectionMode).toBe('single')
    }
  })

  it('resolves multi-select asks via interactive submit', async () => {
    const bridge = new TuiApprovalBridge('session-ask-2')
    registry.registerMessenger(bridge)

    installApprovalRouter({
      resolveMessenger: (platform) => platform === 'tui' ? bridge : undefined,
      buttonCallbackPlatforms: ['tui'],
    })

    const ask = handleAskOp({
      question: 'Pick many',
      choices: ['A', 'B', 'C'],
      selectionMode: 'multi',
      minSelections: 2,
      maxSelections: 3,
      allowTextReply: false,
    }, {
      platform: 'tui',
      channelId: 'local',
      threadId: 'session-ask-2',
      userId: 'tester',
    })

    await new Promise<void>((r) => setImmediate(r))
    expect(await bridge.submitAskMulti([1, 3])).toBe(true)
    const result = await ask
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.selectionMode).toBe('multi')
      expect(result.result.indexes).toEqual([1, 3])
    }
  })

  it('resolves custom-input asks via interactive submit', async () => {
    const bridge = new TuiApprovalBridge('session-ask-3')
    registry.registerMessenger(bridge)

    installApprovalRouter({
      resolveMessenger: (platform) => platform === 'tui' ? bridge : undefined,
      buttonCallbackPlatforms: ['tui'],
    })

    const ask = handleAskOp({
      question: 'Pick or customize',
      choices: ['A', 'B'],
      allowCustomInput: true,
      allowTextReply: false,
    }, {
      platform: 'tui',
      channelId: 'local',
      threadId: 'session-ask-3',
      userId: 'tester',
    })

    await new Promise<void>((r) => setImmediate(r))
    expect(await bridge.submitAskCustom('manual-answer')).toBe(true)
    const result = await ask
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.customText).toBe('manual-answer')
      expect(result.result.index).toBe(0)
    }
  })
})
