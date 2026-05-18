/**
 * /observability/topn smoke — verifies the leaderboard table
 * renders from /api/health/topn with the URL-driven dim/by params.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ObservabilityTopNRoute from './topn'
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

function renderAt(search: string): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/observability/topn${search}`]}>
        <Routes>
          <Route path="/observability/topn" element={<ObservabilityTopNRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('/observability/topn', () => {
  it('renders leaderboard rows + uses ?dim and ?by URL params', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      dim: 'user', by: 'calls', days: 7,
      items: [
        { key: 'wechat:userA', calls: 30, cost: 0.30, errors: 0, avgLatencyMs: 400 },
        { key: 'wechat:userB', calls: 20, cost: 0.20, errors: 2, avgLatencyMs: 600 },
      ],
    }))
    renderAt('?dim=user&by=calls')
    await waitFor(() => {
      expect(screen.getByText('wechat:userA')).toBeInTheDocument()
    })
    expect(screen.getByText('wechat:userB')).toBeInTheDocument()
    const url = String(fetchSpy.mock.calls[0]![0])
    expect(url).toContain('dim=user')
    expect(url).toContain('by=calls')
  })

  it('empty items → empty state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      dim: 'agent', by: 'cost', days: 7, items: [],
    }))
    renderAt('')
    await waitFor(() => {
      expect(screen.getByText(/No data$/)).toBeInTheDocument()
    })
  })
})
