/**
 * /tasks/bgjobs smoke — verifies the bgjobs list flattens the
 * `groups` response shape into a single DataTable, surfaces the
 * root label via the join with `data.roots`, and renders the
 * empty state when the API returns no jobs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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
      <MemoryRouter initialEntries={['/tasks/bgjobs']}>
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
          { id: 'claude', path: '/c', label: 'Claude Code' },
          { id: 'opencode', path: '/o', label: 'opencode' },
        ],
        groups: [
          { rootId: 'claude',   jobs: [
            { id: 'a1', name: 'compile', status: 'running', pid: 123, started_at: '2026-05-18T08:00:00Z', ended_at: null, exit_code: null, restart_generation: 1, rootId: 'claude' },
          ] },
          { rootId: 'opencode', jobs: [
            { id: 'b1', name: 'fmt', status: 'completed', pid: null, started_at: '2026-05-18T07:00:00Z', ended_at: '2026-05-18T07:00:05Z', exit_code: 0, restart_generation: 1, rootId: 'opencode' },
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
    // Root label join via data.roots is what we want to assert
    expect(within(table).getByText('Claude Code')).toBeInTheDocument()
    expect(within(table).getByText('opencode')).toBeInTheDocument()
    // Exit code rendering — 0 → "ok"
    expect(within(table).getByText('ok')).toBeInTheDocument()
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
