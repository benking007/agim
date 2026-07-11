/**
 * /observability/audit smoke — verifies invocation rows render
 * with outcome badges, and stats line shows totals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ObservabilityAuditRoute from './audit'
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
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/observability/audit']}>
        <Routes>
          <Route path="/observability/audit" element={<ObservabilityAuditRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('/observability/audit', () => {
  it('renders invocation rows + outcome badges + stats line', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      invocations: [
        { id: 1, trace_id: 't1', ts: '2026-05-18T08:00:00Z',
          user_id: 'wechat:u1', platform: 'wechat', agent: 'claude',
          intent: 'analyze receipt', prompt_len: 12, response_len: 100,
          duration_ms: 500, cost: 0.0012, success: 1, error: null },
        { id: 2, trace_id: 't2', ts: '2026-05-18T08:01:00Z',
          user_id: 'wechat:u2', platform: 'wechat', agent: 'codex',
          intent: 'lint', prompt_len: 8, response_len: 0,
          duration_ms: 1200, cost: 0.0001, success: 0, error: 'boom' },
      ],
      stats: { total: 42, byAgent: { claude: 30, codex: 12 }, totalCost: 0.123 },
    }))
    renderPage()
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).getByText('analyze receipt')).toBeInTheDocument()
    })
    const table = screen.getByRole('table')
    expect(within(table).getByText('lint')).toBeInTheDocument()
    expect(within(table).getByText('ok')).toBeInTheDocument()
    expect(within(table).getByText('fail')).toBeInTheDocument()
    // Stats line — "Total" appears both as the stats label and as
    // a column header substring; use getAllByText for presence.
    expect(screen.getAllByText(/Total/).length).toBeGreaterThan(0)
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('empty invocations → empty state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      invocations: [],
      stats: { total: 0, byAgent: {}, totalCost: 0 },
    }))
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('No invocations').length).toBeGreaterThan(0)
    })
  })
})
