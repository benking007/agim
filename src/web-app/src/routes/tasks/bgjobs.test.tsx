/**
 * /tasks/bgjobs smoke — flattens `groups`, surfaces root labels (with
 * legacy badge), status i18n, and opens the detail dialog on row click.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import BgjobsRoute from './bgjobs'
import '@/i18n'

beforeEach(() => {
  localStorage.setItem('agim_token', 'tok')
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function renderPage(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/tasks/bgjobs']}>
        <Routes>
          <Route path="/tasks/bgjobs" element={<BgjobsRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

describe('/tasks/bgjobs', () => {
  it('flattens grouped response into a single table', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        roots: [
          { id: 'agim', path: '/a', label: 'Agim' },
          { id: 'claude', path: '/c', label: 'Claude Code' },
        ],
        groups: [
          { rootId: 'agim', jobs: [
            { id: '20260518-080000-compile-ab12', name: 'compile', status: 'running', pid: 123, started_at: '2026-05-18T08:00:00Z', ended_at: null, exit_code: null, restart_generation: 1, rootId: 'agim' },
          ] },
          { rootId: 'claude', jobs: [
            { id: '20260518-070000-fmt-cd34', name: 'fmt', status: 'completed', pid: null, started_at: '2026-05-18T07:00:00Z', ended_at: '2026-05-18T07:00:05Z', exit_code: 0, restart_generation: 1, rootId: 'claude' },
          ] },
        ],
      }),
    )
    renderPage()
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).getByText('compile')).toBeInTheDocument()
    })
    const table = screen.getByRole('table')
    expect(within(table).getByText('fmt')).toBeInTheDocument()
    expect(within(table).getByText('Agim')).toBeInTheDocument()
    expect(within(table).getByText('Claude Code')).toBeInTheDocument()
    expect(within(table).getByText('legacy')).toBeInTheDocument()
    expect(within(table).getByText('Running')).toBeInTheDocument()
    expect(within(table).getByText('ok')).toBeInTheDocument()
    expect(screen.getByText('1 running')).toBeInTheDocument()
  })

  it('opens detail dialog on row click', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/bgjobs/job-1')) {
        return jsonResponse({
          job: {
            id: 'job-1',
            name: 'train',
            status: 'completed',
            pid: null,
            started_at: '2026-05-18T08:00:00Z',
            ended_at: '2026-05-18T08:01:00Z',
            exit_code: 0,
            restart_generation: 1,
            rootId: 'agim',
            cmd: ['python', 'train.py'],
            workdir: '/tmp/work',
            out_dir: '/a/job-1/out',
            log_path: '/a/job-1/log.txt',
            resources: null,
            log_tail: 'epoch 1 done\n',
          },
        })
      }
      return jsonResponse({
        roots: [{ id: 'agim', path: '/a', label: 'Agim' }],
        groups: [
          { rootId: 'agim', jobs: [
            { id: 'job-1', name: 'train', status: 'completed', pid: null, started_at: '2026-05-18T08:00:00Z', ended_at: '2026-05-18T08:01:00Z', exit_code: 0, restart_generation: 1, rootId: 'agim' },
          ] },
        ],
      })
    })

    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('train').length).toBeGreaterThan(0)
    })
    // Desktop table + mobile cards both mount; click the table cell.
    fireEvent.click(within(screen.getByRole('table')).getByText('train'))
    await waitFor(() => {
      expect(screen.getByText('python train.py')).toBeInTheDocument()
    })
    expect(screen.getByText('/tmp/work')).toBeInTheDocument()
    expect(screen.getByText(/epoch 1 done/)).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/bgjobs/job-1'))).toBe(true)
  })

  it('renders empty state when no jobs found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ roots: [], groups: [] }),
    )
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('No background jobs').length).toBeGreaterThan(0)
    })
  })
})
