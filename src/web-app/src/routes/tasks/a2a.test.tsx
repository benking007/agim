/**
 * /tasks/a2a smoke — verifies the stats strip + recent rows render
 * from two parallel queries, and the empty state shows on empty
 * rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import A2ARoute from './a2a'
import '@/i18n'

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

function renderPage(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/tasks/a2a']}>
        <Routes>
          <Route path="/tasks/a2a" element={<A2ARoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('/tasks/a2a', () => {
  it('renders stats + recent rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/api/a2a/stats')) {
        return jsonResponse({ total: 42, recent24h: 7, maxDepth: 3, byStatus: [], byAgent: [] })
      }
      if (u.includes('/api/a2a/recent')) {
        return jsonResponse({
          rows: [
            { id: 1, agent: 'claude', parent_id: null, call_depth: 0, status: 'completed', prompt: 'root', result: 'r', error: null, created_at: '2026-05-18T08:00:00Z', started_at: null, completed_at: null, delivered_at: null },
            { id: 2, agent: 'codex',  parent_id: 1,    call_depth: 1, status: 'running',   prompt: 'child', result: null, error: null, created_at: '2026-05-18T08:01:00Z', started_at: null, completed_at: null, delivered_at: null },
          ],
        })
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).getByText('root')).toBeInTheDocument()
    })
    const table = screen.getByRole('table')
    expect(within(table).getByText('child')).toBeInTheDocument()
    // Stats render — 42 is the unique total
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('renders empty state when no rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/api/a2a/stats')) {
        return jsonResponse({ total: 0, recent24h: 0, maxDepth: 0, byStatus: [], byAgent: [] })
      }
      if (u.includes('/api/a2a/recent')) {
        return jsonResponse({ rows: [] })
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('No agent-to-agent calls yet').length).toBeGreaterThan(0)
    })
  })
})
