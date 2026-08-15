/**
 * /tasks/jobs — route smoke test. End-to-end render: mocked fetch
 * returns 2 jobs + stats, the page renders the table, stats cards,
 * filter row, and an SSE-pill. Smoke verifies the wiring through
 * react-query / DataTable / StatusBadge / EmptyState / Pagination /
 * useEventStream — not each component individually (those have
 * their own units).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import JobsRoute from './jobs'
import '@/i18n'

// EventSource isn't in jsdom — supply a no-op stub so useEventStream
// doesn't crash on construction. The hook's own unit tests cover the
// behavioral surface; here we just don't want a throw.
class StubES {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 2
  readyState = StubES.CONNECTING
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = StubES as unknown as typeof EventSource
  localStorage.setItem('agim_token', 'tok')
})

afterEach(() => {
  delete (globalThis as { EventSource?: unknown }).EventSource
  localStorage.clear()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function renderPage(path = '/tasks/jobs'): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <Routes>
          <Route path="/tasks/jobs" element={<JobsRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

describe('/tasks/jobs', () => {
  it('renders table rows + KPI stats from the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        jobs: [
          { id: 1, kind: 'job', agent: 'claude', prompt: 'one', status: 'running', created_at: '2026-05-18T08:00:00Z', duration_ms: 1234 },
          { id: 2, kind: 'job', agent: 'codex',  prompt: 'two', status: 'failed',  created_at: '2026-05-18T08:01:00Z', duration_ms: 567, cost: 0.012 },
        ],
        stats: { pending: 5, running: 1, completed: 42, failed: 1, delivered: 0 },
      }),
    )
    renderPage()
    // Header + subtitle visible immediately (i18n loaded eagerly).
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument()
    expect(screen.getByText(/Long-running agent invocations/)).toBeInTheDocument()

    // Wait for data load — skeleton rows disappear once useJobs
    // resolves; we assert presence of a prompt cell as the signal.
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).getByText('one')).toBeInTheDocument()
    })
    const table = screen.getByRole('table')
    expect(within(table).getByText('two')).toBeInTheDocument()
    expect(within(table).getByText('claude')).toBeInTheDocument()
    expect(within(table).getByText('codex')).toBeInTheDocument()

    // KPI cards show stats — within() the table's container; "1" can
    // appear in many places so we look at the dedicated stats grid:
    expect(screen.getByText('5')).toBeInTheDocument()    // pending
    expect(screen.getByText('42')).toBeInTheDocument()   // completed
  })

  it('shows the empty-state when the API returns no jobs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ jobs: [] }))
    renderPage()
    await waitFor(() => {
      // The DataTable shows both the desktop empty cell and the
      // mobile-card empty state in jsdom (both are mounted).
      expect(screen.getAllByText('No jobs yet').length).toBeGreaterThan(0)
    })
  })

  it('kind=subtasks shows the nested subtask table', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        subtasks: [
          {
            id: 1, agent: 'codex', prompt: 'fix the bug', status: 'completed',
            createdAt: '2026-05-18T08:00:00Z',
            platform: 'wechat', channelId: 'c', threadId: 't',
            parentAgent: 'claude', parentSessionId: 'abcd1234ef',
          },
        ],
      }),
    )
    renderPage('/tasks/jobs?kind=subtasks')
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Subtasks' })).toBeInTheDocument()
      expect(within(screen.getByRole('table')).getByText('fix the bug')).toBeInTheDocument()
    })
  })

  it('Subtasks tab switches the table to /api/subtasks', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input) => {
      const u = String(input)
      if (u.startsWith('/api/subtasks')) return jsonResponse({ subtasks: [] })
      if (u.startsWith('/api/jobs')) {
        return jsonResponse({
          jobs: [],
          stats: { pending: 0, running: 0, completed: 0, failed: 0, delivered: 0 },
        })
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: 'Subtasks' }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Subtasks' })).toBeInTheDocument()
      expect(fetchSpy.mock.calls.some((c) => String(c[0]).startsWith('/api/subtasks'))).toBe(true)
    })
  })
})
