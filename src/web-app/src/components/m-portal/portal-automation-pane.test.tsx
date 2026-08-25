import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import '@/i18n'

const getWorkspaceFiles = vi.fn()

vi.mock('@/lib/api/endpoints', () => ({
  api: {
    getWorkspaceFiles: (...args: unknown[]) => getWorkspaceFiles(...args),
    resolveWorkspacePath: vi.fn(),
  },
}))

vi.mock('@/hooks/use-schedules', () => ({
  useSchedules: () => ({
    isLoading: false,
    data: {
      schedules: [
        {
          id: 7,
          name: 'gold-daily',
          agent: 'agim',
          cron: '30 9 * * *',
          enabled: 1,
          prompt: '<!-- agim:schedule {"model":"deepseek-v4-pro","artifacts":"PROJECTS/gold-daily"} -->\n写日报',
        },
      ],
    },
  }),
  useUpdateSchedule: () => ({ isPending: false, mutate: vi.fn() }),
  useDeleteSchedule: () => ({ mutate: vi.fn() }),
  useCreateSchedule: () => ({ isPending: false, mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-jobs', () => ({
  useJobs: () => ({
    isLoading: false,
    data: {
      jobs: [
        {
          id: 99,
          agent: 'agim',
          status: 'completed',
          prompt: '<!-- agim:schedule {"artifacts":"PROJECTS/gold-daily"} -->\n写日报',
          result: 'done',
        },
      ],
    },
  }),
}))

vi.mock('@/hooks/use-workspace', () => ({
  useAgentsStatus: () => ({ data: { agim: true } }),
}))

vi.mock('@/hooks/use-llm-admin', () => ({
  useLlmList: () => ({ data: { backends: [{ name: 'deepseek-v4-pro' }] } }),
}))

import { PortalAutomationPane } from './portal-automation-pane'

const PROJECTS = {
  type: 'dir' as const,
  agent: 'agim',
  path: 'PROJECTS',
  base: '/home/u/.agim-workspaces/agim',
  entries: [
    { name: 'gold-daily', isDir: true, size: null, mtime: '2026-08-14T00:00:00Z' },
    { name: 'README.md', isDir: false, size: 12, mtime: '2026-08-14T00:00:00Z' },
  ],
}

function renderPane(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <PortalAutomationPane dark={false} defaultAgent="agim" />
    </QueryClientProvider>,
  )
}

describe('PortalAutomationPane', () => {
  afterEach(() => {
    getWorkspaceFiles.mockReset()
  })

  it('lists a schedule with its artifacts path', () => {
    renderPane()
    expect(screen.getByTestId('portal-automation-pane')).toBeInTheDocument()
    expect(screen.getByText('gold-daily')).toBeInTheDocument()
    expect(screen.getByText(/PROJECTS\/gold-daily/)).toBeInTheDocument()
  })

  it('shows artifacts on the run history tab', async () => {
    const user = userEvent.setup()
    renderPane()
    await user.click(screen.getByRole('button', { name: 'Run history' }))
    expect(screen.getByTestId('portal-schedule-run-99')).toBeInTheDocument()
    expect(screen.getByText(/PROJECTS\/gold-daily/)).toBeInTheDocument()
  })

  it('fills the output folder from the workspace picker', async () => {
    getWorkspaceFiles.mockResolvedValue(PROJECTS)
    const user = userEvent.setup()
    renderPane()
    await user.click(screen.getByRole('button', { name: 'New scheduled task' }))
    expect(screen.getByTestId('automation-artifacts-input')).toHaveValue('PROJECTS/schedule-output')
    await user.click(screen.getByTestId('automation-artifacts-browse'))

    await waitFor(() => {
      expect(within(screen.getByTestId('workspace-picker')).getByText('gold-daily')).toBeInTheDocument()
    })
    const picker = screen.getByTestId('workspace-picker')
    expect(within(picker).queryByText('README.md')).not.toBeInTheDocument()

    const useButtons = within(picker).getAllByRole('button', { name: 'Use this folder' })
    const row = useButtons.find((b) => b.getAttribute('data-testid') !== 'workspace-picker-use-current')
    if (!row) throw new Error('expected a row-level Use this folder button')
    await user.click(row)

    await waitFor(() => {
      expect(screen.getByTestId('automation-artifacts-input')).toHaveValue('PROJECTS/gold-daily')
    })
  })
})
