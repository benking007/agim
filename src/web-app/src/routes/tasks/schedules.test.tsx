/**
 * /tasks/schedules smoke — verifies rows render with their cron
 * expression + enabled badge, and the empty state shows on []
 * response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SchedulesRoute from './schedules'
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
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/tasks/schedules']}>
        <Routes>
          <Route path="/tasks/schedules" element={<SchedulesRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('/tasks/schedules', () => {
  it('renders rows including cron expression + enabled badge', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        schedules: [
          { id: 1, name: 'daily', agent: 'claude', prompt: 'morning', cron: '0 9 * * *', enabled: true,  next_run: '2026-05-19T09:00:00Z' },
          { id: 2, name: 'weekly', agent: 'codex', prompt: 'report',  cron: '0 0 * * 1', enabled: false, next_run: '2026-05-19T00:00:00Z', last_run: '2026-05-12T00:00:00Z' },
        ],
      }),
    )
    renderPage()
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).getByText('daily')).toBeInTheDocument()
    })
    const table = screen.getByRole('table')
    expect(within(table).getByText('0 9 * * *')).toBeInTheDocument()
    expect(within(table).getByText('On')).toBeInTheDocument()
    expect(within(table).getByText('Off')).toBeInTheDocument()
  })

  it('shows the empty state when API returns no schedules', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ schedules: [] }))
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('No schedules configured').length).toBeGreaterThan(0)
    })
  })
})
