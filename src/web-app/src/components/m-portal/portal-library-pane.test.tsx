import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import '@/i18n'

vi.mock('@/hooks/use-workspace', () => ({
  useWorkspaceFiles: (_agent: string, path: string) => {
    if (!path) {
      return {
        isLoading: false,
        data: {
          type: 'dir',
          entries: [
            { name: 'AGENTS.md', isDir: false, size: 12, mtime: null },
            { name: 'PROJECTS', isDir: true, size: null, mtime: null },
          ],
        },
      }
    }
    if (path === 'AGENTS.md') {
      return {
        isLoading: false,
        data: {
          type: 'file',
          path: 'AGENTS.md',
          encoding: 'utf-8',
          content: '# Hello',
          truncated: false,
        },
      }
    }
    return { isLoading: false, data: { type: 'dir', entries: [] } }
  },
}))

import { PortalLibraryPane } from './portal-library-pane'

describe('PortalLibraryPane', () => {
  it('renders a directory tree and opens a file preview', async () => {
    const user = userEvent.setup()
    const onPathChange = vi.fn()
    const { rerender } = render(
      <PortalLibraryPane dark={false} agentId="agim" path="" onPathChange={onPathChange} />,
    )
    expect(screen.getByTestId('portal-library-pane')).toBeInTheDocument()
    expect(screen.getByText('AGENTS.md')).toBeInTheDocument()
    expect(screen.getByText('PROJECTS')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'AGENTS.md' }))
    expect(onPathChange).toHaveBeenCalledWith('AGENTS.md')

    rerender(
      <PortalLibraryPane dark={false} agentId="agim" path="AGENTS.md" onPathChange={onPathChange} />,
    )
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Code' })).toBeInTheDocument()
  })
})
