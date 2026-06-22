import type { TuiApprovalChoice, TuiApprovalView } from './approval-bridge.js'

export interface TuiApprovalAction {
  choice: TuiApprovalChoice
  label: string
  color: 'green' | 'cyan' | 'red'
}

const NORMAL_APPROVAL_ACTIONS: readonly TuiApprovalAction[] = [
  { choice: 'y', label: '批准', color: 'green' },
  { choice: 'a', label: '同类默认批准', color: 'cyan' },
  { choice: 'n', label: '拒绝', color: 'red' },
]

const AUTO_ALLOW_APPROVAL_ACTIONS: readonly TuiApprovalAction[] = [
  { choice: 'n', label: '拒绝', color: 'red' },
]

export interface TuiApprovalStatusLine {
  toolName: string
  label: string
  color: 'green' | 'yellow' | 'red'
}

export function approvalActionsFor(approval: TuiApprovalView | null): readonly TuiApprovalAction[] {
  if (!approval) return NORMAL_APPROVAL_ACTIONS
  if (approval.prompt.mode === 'auto-allow') return AUTO_ALLOW_APPROVAL_ACTIONS
  return NORMAL_APPROVAL_ACTIONS
}

export function approvalDecisionLabel(decision: NonNullable<TuiApprovalView['outcome']>['decision']): string {
  switch (decision) {
    case 'allowed': return '已批准'
    case 'allowed-pinned': return '已批准并记住本类请求'
    case 'denied': return '已拒绝'
    case 'denied-revoked': return '已拒绝并撤销自动批准'
    case 'expired': return '已过期'
  }
}

function approvalDecisionColor(decision: NonNullable<TuiApprovalView['outcome']>['decision']): 'green' | 'yellow' | 'red' {
  switch (decision) {
    case 'allowed':
    case 'allowed-pinned':
      return 'green'
    case 'expired':
      return 'yellow'
    case 'denied':
    case 'denied-revoked':
      return 'red'
  }
}

export function toApprovalStatusLine(approval: TuiApprovalView): TuiApprovalStatusLine | null {
  if (!approval.outcome) return null
  return {
    toolName: approval.prompt.toolName,
    label: approvalDecisionLabel(approval.outcome.decision),
    color: approvalDecisionColor(approval.outcome.decision),
  }
}
