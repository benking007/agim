import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApprovalDock } from './approval-dock'
import type { PendingApproval } from '@/hooks/use-chat'
import '@/i18n'

function approval(over: Partial<PendingApproval['prompt']> = {}): PendingApproval {
  return {
    messageId: 'm-apv',
    prompt: {
      reqId: 'req-1',
      toolName: 'agim_exec',
      inputJson: '{"cmd":"ls"}',
      mode: 'explicit',
      ...over,
    },
  }
}

describe('ApprovalDock', () => {
  it('renders nothing when empty', () => {
    const { container } = render(<ApprovalDock approvals={[]} onApprove={() => true} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a floating sheet with tool name and actions', () => {
    render(<ApprovalDock approvals={[approval()]} onApprove={() => true} />)
    expect(screen.getByRole('region', { name: /Tool approval|工具授权/ })).toBeInTheDocument()
    expect(screen.getByText('agim_exec')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Allow|批准/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Deny|拒绝/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Auto for similar|本类自动放行/ })).not.toBeInTheDocument()
  })

  it('shows Auto for similar when explicit + canPin', () => {
    render(<ApprovalDock approvals={[approval({ canPin: true })]} onApprove={() => true} />)
    expect(screen.getByRole('button', { name: /Allow|批准/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Auto for similar|本类自动放行/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Deny|拒绝/ })).toBeInTheDocument()
    expect(screen.getByText(/needs confirmation|需确认/)).toBeInTheDocument()
  })

  it('pretty-prints JSON input', () => {
    render(<ApprovalDock approvals={[approval()]} onApprove={() => true} />)
    expect(screen.getByText(/"cmd": "ls"/)).toBeInTheDocument()
  })

  it('fires onApprove with the chosen letter', async () => {
    const user = userEvent.setup()
    const onApprove = vi.fn(() => true)
    render(<ApprovalDock approvals={[approval()]} onApprove={onApprove} />)
    await user.click(screen.getByRole('button', { name: /Allow|批准/ }))
    expect(onApprove).toHaveBeenCalledWith('m-apv', 'req-1', 'y')
  })
})
