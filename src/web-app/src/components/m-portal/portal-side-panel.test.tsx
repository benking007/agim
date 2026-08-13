/**
 * Portal left rail — conversation list click switches the active thread.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Brain } from 'lucide-react'

import '@/i18n'
import { PortalSidePanel } from './portal-side-panel'

const visual = {
  color: 'from-sky-500 to-blue-600',
  icon: Brain,
  category: 'Featured',
  tagline: 'Agim native agent',
}

function renderPanel(over: Partial<Parameters<typeof PortalSidePanel>[0]> = {}) {
  const onSwitchSession = vi.fn()
  const onNew = vi.fn()
  render(
    <PortalSidePanel
      dark={false}
      agentId="agim"
      visual={visual}
      AgentIcon={Brain}
      activeTab="chat"
      status="open"
      lang="en"
      showClose={false}
      onClose={() => {}}
      onChat={() => {}}
      onExplore={() => {}}
      onNew={onNew}
      onToggleLang={() => {}}
      sessions={[
        { id: 'web-aaaa1111', title: 'First chat', updatedAt: Date.now() },
        { id: 'web-bbbb2222', title: 'Older chat', updatedAt: Date.now() - 60_000 },
      ]}
      activeSessionId="web-aaaa1111"
      onSwitchSession={onSwitchSession}
      {...over}
    />,
  )
  return { onSwitchSession, onNew }
}

describe('PortalSidePanel conversations', () => {
  it('lists saved sessions and click calls onSwitchSession', async () => {
    const user = userEvent.setup()
    const { onSwitchSession } = renderPanel()

    expect(screen.getByText('Conversations')).toBeInTheDocument()
    expect(screen.getByText('First chat')).toBeInTheDocument()
    expect(screen.getByText('Older chat')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Older chat/ }))
    expect(onSwitchSession).toHaveBeenCalledWith('web-bbbb2222')
  })

  it('keeps New conversation as a shortcut that mints a thread', async () => {
    const user = userEvent.setup()
    const { onNew, onSwitchSession } = renderPanel()
    await user.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(onNew).toHaveBeenCalled()
    expect(onSwitchSession).not.toHaveBeenCalled()
  })
})
