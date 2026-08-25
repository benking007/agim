/**
 * Portal left rail — conversation list click switches the active thread.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Brain } from 'lucide-react'

import '@/i18n'
import { useAuth } from '@/stores/auth'
import { PortalSidePanel } from './portal-side-panel'

const visual = {
  color: 'from-sky-500 to-blue-600',
  icon: Brain,
  category: 'Featured',
  tagline: 'Agim native agent',
}

const cloudWorkspace = {
  id: 'cloud',
  kind: 'cloud' as const,
  name: 'cloud',
  createdAt: 0,
}

function renderPanel(over: Partial<Parameters<typeof PortalSidePanel>[0]> = {}) {
  const onSwitchSession = vi.fn()
  const onNew = vi.fn()
  const onNewWorkspace = vi.fn()
  const onSelectWorkspace = vi.fn()
  const onToggleWorkspace = vi.fn()
  const onArchiveSession = vi.fn()
  const onArchiveWorkspace = vi.fn()
  render(
    <PortalSidePanel
      dark={false}
      agentId="agim"
      visual={visual}
      AgentIcon={Brain}
      status="open"
      lang="en"
      showClose={false}
      onClose={() => {}}
      onNew={onNew}
      onToggleLang={() => {}}
      sessions={[
        { id: 'web-aaaa1111', title: 'First chat', updatedAt: Date.now(), workspaceId: 'cloud' },
        { id: 'web-bbbb2222', title: 'Older chat', updatedAt: Date.now() - 60_000, workspaceId: 'cloud' },
      ]}
      activeSessionId="web-aaaa1111"
      onSwitchSession={onSwitchSession}
      workspaces={[cloudWorkspace]}
      activeWorkspaceId="cloud"
      collapsedWorkspaces={{}}
      onToggleWorkspace={onToggleWorkspace}
      onSelectWorkspace={onSelectWorkspace}
      onNewWorkspace={onNewWorkspace}
      onArchiveSession={onArchiveSession}
      onArchiveWorkspace={onArchiveWorkspace}
      {...over}
    />,
  )
  return { onSwitchSession, onNew, onNewWorkspace, onSelectWorkspace, onToggleWorkspace, onArchiveSession, onArchiveWorkspace }
}

afterEach(() => {
  useAuth.getState().clear()
})

describe('PortalSidePanel conversations', () => {
  it('lists saved sessions under the cloud workspace and click calls onSwitchSession', async () => {
    const user = userEvent.setup()
    const { onSwitchSession } = renderPanel()

    expect(screen.getByText('Workspaces')).toBeInTheDocument()
    expect(screen.getByText('Cloud')).toBeInTheDocument()
    expect(screen.getByText('First chat')).toBeInTheDocument()
    expect(screen.getByText('Older chat')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Older chat/ }))
    expect(onSwitchSession).toHaveBeenCalledWith('web-bbbb2222')
  })

  it('keeps New task as a shortcut and hides Explore', async () => {
    const user = userEvent.setup()
    const { onNew, onSwitchSession } = renderPanel()
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skills' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Automation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Library' })).toBeInTheDocument()
    expect(screen.queryByText('Explore Agents Directory')).not.toBeInTheDocument()
    expect(screen.queryByText('Interactive Chat')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New task' }))
    expect(onNew).toHaveBeenCalled()
    expect(onSwitchSession).not.toHaveBeenCalled()
  })

  it('switches pane without creating a conversation', async () => {
    const user = userEvent.setup()
    const onPaneChange = vi.fn()
    const { onNew } = renderPanel({ onPaneChange })
    await user.click(screen.getByRole('button', { name: 'Library' }))
    expect(onPaneChange).toHaveBeenCalledWith('library')
    expect(onNew).not.toHaveBeenCalled()
  })

  it('hides the workspace tree on non-chat panes', () => {
    renderPanel({ pane: 'library' })
    expect(screen.queryByText('Workspaces')).not.toBeInTheDocument()
    expect(screen.queryByText('First chat')).not.toBeInTheDocument()
  })

  it('nests sessions under their workspace and opens the directory picker', async () => {
    const user = userEvent.setup()
    const { onNewWorkspace } = renderPanel({
      workspaces: [
        cloudWorkspace,
        { id: 'ws-local1', kind: 'local', name: 'proj', path: '/home/u/.agim-workspaces/agim/proj', createdAt: 2 },
      ],
      sessions: [
        { id: 'web-aaaa1111', title: 'Cloud chat', updatedAt: Date.now() - 3_600_000, workspaceId: 'cloud' },
        { id: 'web-cccc3333', title: 'Local review', updatedAt: Date.now() - 3_600_000, workspaceId: 'ws-local1' },
      ],
    })

    expect(screen.getByText('Cloud chat')).toBeInTheDocument()
    expect(screen.getByText('Local review')).toBeInTheDocument()
    expect(screen.getByText('proj')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    expect(onNewWorkspace).toHaveBeenCalled()
  })

  it('archives a session from the row button without switching', async () => {
    const user = userEvent.setup()
    const { onArchiveSession, onSwitchSession } = renderPanel()
    const buttons = screen.getAllByRole('button', { name: 'Archive conversation' })
    expect(buttons).toHaveLength(2)
    const older = buttons[1]
    expect(older).toBeTruthy()
    await user.click(older)
    expect(onArchiveSession).toHaveBeenCalledWith('web-bbbb2222')
    expect(onSwitchSession).not.toHaveBeenCalled()
  })

  it('archives a named workspace but not the cloud root', async () => {
    const user = userEvent.setup()
    const { onArchiveWorkspace, onSelectWorkspace } = renderPanel({
      workspaces: [
        cloudWorkspace,
        { id: 'ws-local1', kind: 'local', name: 'proj', path: '/tmp/proj', createdAt: 2 },
      ],
    })
    expect(screen.getByRole('button', { name: 'Archive workspace' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Archive workspace' }))
    expect(onArchiveWorkspace).toHaveBeenCalledWith('ws-local1')
    expect(onSelectWorkspace).not.toHaveBeenCalled()
  })

  it('keeps workspace-row selection as teal text without a background fill', () => {
    renderPanel()
    const workspaceRow = screen.getByTestId('portal-workspace-row-cloud')
    expect(workspaceRow.className).toMatch(/text-teal-600/)
    expect(workspaceRow.className).not.toMatch(/bg-zinc-/)
    const sessionRow = screen.getByText('First chat').closest('div.group\\/session')
    expect(sessionRow?.className).toMatch(/bg-zinc-100/)
  })

  it('renders an icon-only rail when collapsed', () => {
    const onToggle = vi.fn()
    renderPanel({ railCollapsed: true, onToggleRailCollapsed: onToggle })
    expect(screen.getByTestId('portal-rail-collapsed')).toBeInTheDocument()
    expect(screen.queryByText('Workspaces')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
  })

  it('shows the signed-in username and a logout button', () => {
    useAuth.getState().setUser({
      id: 'usr_1',
      username: 'tester',
      displayName: 'tester',
      role: 'admin',
    })
    renderPanel()
    expect(screen.getByTestId('portal-signed-in-user')).toHaveTextContent('tester')
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument()
  })
})
