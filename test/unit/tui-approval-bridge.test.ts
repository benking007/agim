import { afterEach, describe, expect, it } from 'bun:test'

import { TuiApprovalBridge } from '../../src/cli-ui/tui/approval-bridge'
import { approvalBus, type Decision } from '../../src/core/approval-bus'
import {
  install as installApprovalRouter,
  uninstall as uninstallApprovalRouter,
} from '../../src/core/approval-router'

describe('TuiApprovalBridge', () => {
  afterEach(async () => {
    uninstallApprovalRouter()
    await approvalBus.stop()
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
})
