import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import type { ChatMessage } from '@/hooks/use-chat'
import { MessageBubble } from './message-bubble'

function explicitApprovalMessage(): ChatMessage {
  return {
    id: 'm-explicit',
    role: 'system',
    content: '',
    timestamp: Date.now(),
    approval: {
      messageId: 'm-explicit',
      prompt: {
        reqId: 'req-explicit',
        toolName: 'native_exit_plan_mode',
        inputJson: '{"plan":"- implement"}',
        mode: 'explicit',
      },
    },
  }
}

describe('MessageBubble explicit approval', () => {
  it('offers one-time allow and deny without auto-allow', () => {
    render(<MessageBubble msg={explicitApprovalMessage()} onApprove={() => true} />)

    expect(screen.getByText('仅本次确认')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批准' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '本类自动放行' })).not.toBeInTheDocument()
  })
})
