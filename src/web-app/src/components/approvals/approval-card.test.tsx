/**
 * ApprovalCard — verify:
 *   * Renders tool name + platform + thread id + JSON preview
 *   * Allow / Deny click → onResolve called with the right behavior
 *   * busy flag disables both buttons
 *   * Stale (ageMs > 90s) adds the danger border + warning icon
 *   * autoAllow approval shows the "auto-allow" tag
 *   * JSON preview truncates above 12 lines
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ApprovalCard } from './approval-card'
import '@/i18n'
import type { Approval } from '@/types/api'

const baseApproval: Approval = {
  reqId:        'r-1',
  runId:        'run-1',
  threadId:     'wechat:room:1234',
  platform:     'wechat',
  toolName:     'Bash',
  input:        { command: 'ls -la /tmp' },
  fingerprint:  'fp-1',
  autoAllow:    false,
  registeredAt: Date.now(),
  ageMs:        10_000,
}

describe('ApprovalCard', () => {
  it('renders tool name + platform + thread id', () => {
    render(<ApprovalCard approval={baseApproval} onResolve={() => {}} />)
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('wechat')).toBeInTheDocument()
    expect(screen.getByText('wechat:room:1234')).toBeInTheDocument()
  })

  it('renders the JSON preview of the tool input', () => {
    render(<ApprovalCard approval={baseApproval} onResolve={() => {}} />)
    const pre = document.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('"command"')
    expect(pre?.textContent).toContain('ls -la /tmp')
  })

  it('Allow → onResolve("allow"); Deny → onResolve("deny")', () => {
    const onResolve = vi.fn()
    render(<ApprovalCard approval={baseApproval} onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onResolve).toHaveBeenLastCalledWith('allow')
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onResolve).toHaveBeenLastCalledWith('deny')
    expect(onResolve).toHaveBeenCalledTimes(2)
  })

  it('busy flag disables both action buttons', () => {
    render(<ApprovalCard approval={baseApproval} onResolve={() => {}} busy />)
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
  })

  it('ageMs > 90s adds the danger border', () => {
    const { container } = render(
      <ApprovalCard approval={{ ...baseApproval, ageMs: 120_000 }} onResolve={() => {}} />,
    )
    const card = container.firstElementChild as HTMLElement | null
    expect(card?.className).toMatch(/border-danger/)
  })

  it('autoAllow shows the auto-allow tag', () => {
    render(<ApprovalCard approval={{ ...baseApproval, autoAllow: true }} onResolve={() => {}} />)
    expect(screen.getByText('auto-allow')).toBeInTheDocument()
  })

  it('long JSON input is truncated to a line count + summary tail', () => {
    const bigInput: Record<string, string> = {}
    for (let i = 0; i < 30; i++) bigInput[`key${i}`] = `value${i}`
    render(<ApprovalCard approval={{ ...baseApproval, input: bigInput }} onResolve={() => {}} />)
    const pre = document.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toMatch(/… \+\d+ more$/)
  })
})
