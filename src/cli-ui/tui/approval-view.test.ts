import { describe, it, expect } from 'bun:test'

import type { TuiApprovalView } from './approval-bridge.js'
import { approvalActionsFor, toApprovalStatusLine } from './approval-view.js'

function buildApproval(
  mode: TuiApprovalView['prompt']['mode'],
  outcome?: TuiApprovalView['outcome'],
): TuiApprovalView {
  return {
    messageId: 'm1',
    threadId: 't1',
    prompt: {
      reqId: 'r1',
      toolName: 'Bash',
      inputJson: '{"command":"echo hi"}',
      mode,
      graceSeconds: mode === 'auto-allow' ? 5 : undefined,
    },
    outcome,
  }
}

describe('approvalActionsFor', () => {
  it('普通审批返回三选项', () => {
    const actions = approvalActionsFor(buildApproval('normal'))
    expect(actions.map((a) => a.choice)).toEqual(['y', 'a', 'n'])
  })

  it('命中默认放行只返回拒绝按钮', () => {
    const actions = approvalActionsFor(buildApproval('auto-allow'))
    expect(actions).toHaveLength(1)
    expect(actions[0]?.choice).toBe('n')
    expect(actions[0]?.label).toBe('拒绝')
  })

  it('必须确认的审批不提供同类默认批准', () => {
    const actions = approvalActionsFor(buildApproval('explicit'))
    expect(actions.map((a) => a.choice)).toEqual(['y', 'n'])
    expect(actions[0]?.label).toBe('仅批准本次')
  })
})

describe('toApprovalStatusLine', () => {
  it('未结束审批不生成状态条', () => {
    expect(toApprovalStatusLine(buildApproval('normal'))).toBeNull()
  })

  it('审批完成后生成精简状态', () => {
    const done = toApprovalStatusLine(buildApproval('auto-allow', {
      decision: 'denied-revoked',
      atDate: new Date('2026-06-22T10:00:00.000Z'),
    }))
    expect(done).toEqual({
      toolName: 'Bash',
      label: '已拒绝并撤销自动批准',
      color: 'red',
    })
  })
})
