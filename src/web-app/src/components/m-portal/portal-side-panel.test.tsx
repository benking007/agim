/**
 * Portal left rail — conversation list click switches the active thread.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

const cloudWorkspace = {
  id: 'cloud',
  kind: 'cloud' as const,
  name: 'cloud',
  createdAt: 0,
}

function renderPanel(over: Partial<Parameters<typeof PortalSidePanel>[0]> = {}) {
  const onSwitchSession = vi.fn()
  const onNew = vi.fn()
  const onWorkspaceCreated = vi.fn()
  const onSelectWorkspace = vi.fn()
  const onToggleWorkspace = vi.fn()
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
      onWorkspaceCreated={onWorkspaceCreated}
      {...over}
    />,
  )
  return { onSwitchSession, onNew, onWorkspaceCreated, onSelectWorkspace, onToggleWorkspace }
}

describe('PortalSidePanel conversations', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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

  it('keeps New conversation as the only shortcut and hides Explore', async () => {
    const user = userEvent.setup()
    const { onNew, onSwitchSession } = renderPanel()
    expect(screen.queryByRole('button', { name: 'Interactive Chat' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Explore Agents Directory' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(onNew).toHaveBeenCalled()
    expect(onSwitchSession).not.toHaveBeenCalled()
  })

  it('nests sessions under their workspace and creates one from the directory file input', async () => {
    const user = userEvent.setup()
    const { onWorkspaceCreated } = renderPanel({
      workspaces: [
        cloudWorkspace,
        { id: 'ws-local1', kind: 'local', name: 'agim', path: '/Users/a/Work/agim', createdAt: 2 },
      ],
      sessions: [
        { id: 'web-aaaa1111', title: 'Cloud chat', updatedAt: Date.now() - 3_600_000, workspaceId: 'cloud' },
        { id: 'web-cccc3333', title: 'Local review', updatedAt: Date.now() - 3_600_000, workspaceId: 'ws-local1' },
      ],
    })

    expect(screen.getByText('Cloud chat')).toBeInTheDocument()
    expect(screen.getByText('Local review')).toBeInTheDocument()
    expect(screen.getByText('agim')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    expect(screen.queryByText('Select workspace directory')).not.toBeInTheDocument()

    const input = screen.getByTestId('workspace-dir-input') as HTMLInputElement
    const file = new File(['x'], 'package.json')
    Object.defineProperty(file, 'webkitRelativePath', { value: 'ceshi/package.json' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(onWorkspaceCreated).toHaveBeenCalledWith({ name: 'ceshi', path: 'ceshi' })
  })

  it('uses showDirectoryPicker when the browser exposes it', async () => {
    const pick = vi.fn(async () => ({ name: 'agim' }))
    vi.stubGlobal('showDirectoryPicker', pick)
    const user = userEvent.setup()
    const { onWorkspaceCreated } = renderPanel()
    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    expect(pick).toHaveBeenCalled()
    expect(onWorkspaceCreated).toHaveBeenCalledWith({ name: 'agim', path: 'agim' })
  })
})
