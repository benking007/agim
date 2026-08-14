/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import '@/i18n'
import { PortalWorkspacePicker, joinRel } from './portal-workspace-picker'

const getWorkspaceFiles = vi.fn()
const resolveWorkspacePath = vi.fn()

vi.mock('@/lib/api/endpoints', () => ({
  api: {
    getWorkspaceFiles: (...args: unknown[]) => getWorkspaceFiles(...args),
    resolveWorkspacePath: (...args: unknown[]) => resolveWorkspacePath(...args),
  },
}))

const ROOT = {
  type: 'dir' as const,
  agent: 'agim',
  path: '',
  base: '/home/u/.agim-workspaces/agim',
  entries: [
    { name: 'proj', isDir: true, size: null, mtime: '2026-08-14T00:00:00Z' },
    { name: 'AGENTS.md', isDir: false, size: 12, mtime: '2026-08-14T00:00:00Z' },
  ],
}

const PROJ = {
  type: 'dir' as const,
  agent: 'agim',
  path: 'proj',
  base: '/home/u/.agim-workspaces/agim',
  entries: [
    { name: 'src', isDir: true, size: null, mtime: '2026-08-14T00:00:00Z' },
  ],
}

function renderPicker(onPicked = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <PortalWorkspacePicker
        open
        agentId="agim"
        onOpenChange={() => {}}
        onPicked={onPicked}
      />
    </QueryClientProvider>,
  )
  return onPicked
}

describe('joinRel', () => {
  it('joins relative workspace segments', () => {
    expect(joinRel('', 'proj')).toBe('proj')
    expect(joinRel('proj', 'src')).toBe('proj/src')
    expect(joinRel('proj/src', '')).toBe('proj/src')
  })
})

describe('PortalWorkspacePicker', () => {
  afterEach(() => {
    getWorkspaceFiles.mockReset()
    resolveWorkspacePath.mockReset()
  })

  it('lists only directories and refuses to use the workspace root', async () => {
    getWorkspaceFiles.mockResolvedValue(ROOT)
    renderPicker()

    await waitFor(() => {
      expect(screen.getByText('proj')).toBeInTheDocument()
    })
    expect(screen.getByRole('dialog', { name: 'Choose a directory' })).toBeInTheDocument()
    expect(screen.queryByText('AGENTS.md')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-picker-use-current')).not.toBeInTheDocument()
    expect(getWorkspaceFiles).toHaveBeenCalledWith({ agent: 'agim', path: undefined })
  })

  it('selects a subdirectory through the listing', async () => {
    getWorkspaceFiles.mockImplementation(async (q: { path?: string }) => (
      q.path === 'proj' ? PROJ : ROOT
    ))
    resolveWorkspacePath.mockResolvedValue({
      ok: true,
      path: '/home/u/.agim-workspaces/agim/proj',
      name: 'proj',
    })
    const user = userEvent.setup()
    const onPicked = renderPicker()

    await waitFor(() => {
      expect(screen.getByText('proj')).toBeInTheDocument()
    })
    const useButtons = screen.getAllByRole('button', { name: 'Use this folder' })
    const enabled = useButtons.find((b) => !(b as HTMLButtonElement).disabled)
    if (!enabled) throw new Error('expected a row-level Use this folder button')
    await user.click(enabled)

    await waitFor(() => {
      expect(resolveWorkspacePath).toHaveBeenCalledWith({ path: 'proj', agent: 'agim' })
      expect(onPicked).toHaveBeenCalledWith({
        name: 'proj',
        path: '/home/u/.agim-workspaces/agim/proj',
      })
    })
  })

  it('resolves a typed workspace path', async () => {
    getWorkspaceFiles.mockResolvedValue(ROOT)
    resolveWorkspacePath.mockResolvedValue({
      ok: true,
      path: '/home/u/.agim-workspaces/agim/proj',
      name: 'proj',
    })
    const user = userEvent.setup()
    const onPicked = renderPicker()

    await waitFor(() => {
      expect(screen.getByLabelText('Or type a path')).toBeInTheDocument()
    })
    await user.type(screen.getByLabelText('Or type a path'), 'proj')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(resolveWorkspacePath).toHaveBeenCalledWith({ path: 'proj', agent: 'agim' })
      expect(onPicked).toHaveBeenCalledWith({
        name: 'proj',
        path: '/home/u/.agim-workspaces/agim/proj',
      })
    })
  })

  it('shows an error when the path is outside the agent workspace', async () => {
    getWorkspaceFiles.mockResolvedValue(ROOT)
    resolveWorkspacePath.mockResolvedValue({ ok: false, path: null })
    const user = userEvent.setup()
    const onPicked = renderPicker()

    await waitFor(() => {
      expect(screen.getByLabelText('Or type a path')).toBeInTheDocument()
    })
    await user.type(screen.getByLabelText('Or type a path'), '/etc')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/subdirectory/i)
    })
    expect(onPicked).not.toHaveBeenCalled()
  })
})
