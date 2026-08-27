/**
 * @vitest-environment jsdom
 */
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Bot } from 'lucide-react'

import '@/i18n'
import { PortalMessageList } from './portal-message-list'
import type { ChatTurn } from './portal-chat-turns'

vi.mock('./portal-user-content', () => ({
  PortalUserContent: ({ content }: { content: string }) => <span>{content}</span>,
}))

function renderTurns(turns: ChatTurn[]): void {
  render(
    <PortalMessageList
      dark={false}
      active
      chatTurns={turns}
      isEmpty={false}
      isTyping={false}
      currentReplyId={null}
      streamingFallback={false}
      agentId="agim"
      agentColor="#111"
      AgentIcon={Bot}
      portalThreadId="web-test"
      listRef={createRef<HTMLDivElement>()}
      onFillComposer={() => {}}
    />,
  )
}

describe('PortalMessageList send status', () => {
  it('does not show Sending… on a pending user bubble', () => {
    renderTurns([{
      id: 'u-1',
      user: {
        id: 'u-1',
        role: 'user',
        content: '/model deepseek-v4-pro',
        timestamp: 1,
        sendStatus: 'pending',
      },
      replies: [],
    }])
    const bubble = screen.getByText('/model deepseek-v4-pro').closest('[data-user-message]')
    expect(bubble).toHaveAttribute('data-send-status', 'pending')
    expect(screen.queryByText(/发送中|Sending/)).not.toBeInTheDocument()
  })

  it('still shows Send failed on a failed bubble', () => {
    renderTurns([{
      id: 'u-2',
      user: {
        id: 'u-2',
        role: 'user',
        content: 'hello',
        timestamp: 1,
        sendStatus: 'failed',
      },
      replies: [],
    }])
    expect(screen.getByText(/发送失败|Send failed/)).toBeInTheDocument()
  })
})
