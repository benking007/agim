/**
 * /observability/health smoke — verifies KPI strip and per-day
 * table render from /api/health/summary, and the empty branch
 * shows when totals.calls === 0.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ObservabilityHealthRoute from './health'
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
      <MemoryRouter initialEntries={['/observability/health']}>
        <Routes>
          <Route path="/observability/health" element={<ObservabilityHealthRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('/observability/health', () => {
  it('renders KPI strip + by-day table', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      since: '2026-05-11', until: '2026-05-18', days: 7,
      totals: { calls: 123, cost: 1.23, errors: 4, errorRate: 0.032, avgLatencyMs: 450, p95LatencyMs: 1200 },
      byDay: [
        { date: '2026-05-17', calls: 20, cost: 0.20, errors: 1, avgLatencyMs: 500 },
        { date: '2026-05-18', calls: 30, cost: 0.30, errors: 0, avgLatencyMs: 480 },
      ],
    }))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('123')).toBeInTheDocument()         // calls
    })
    expect(screen.getByText('$1.2300')).toBeInTheDocument()       // cost
    expect(screen.getByText('3.2%')).toBeInTheDocument()          // error rate
    expect(screen.getByText('2026-05-17')).toBeInTheDocument()    // by-day row
    expect(screen.getByText('2026-05-18')).toBeInTheDocument()
  })

  it('empty totals → empty state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      since: '2026-05-11', until: '2026-05-18', days: 7,
      totals: { calls: 0, cost: 0, errors: 0, errorRate: 0, avgLatencyMs: 0, p95LatencyMs: 0 },
      byDay: [],
    }))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('No data in this window')).toBeInTheDocument()
    })
  })
})
