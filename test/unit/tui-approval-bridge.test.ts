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
})
