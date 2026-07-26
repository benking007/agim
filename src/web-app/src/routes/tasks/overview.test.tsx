import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import TasksOverviewRoute from './overview'
import '@/i18n'

beforeEach(() => {
  localStorage.setItem('agim_token', 'tok')
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderPage(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/tasks']}>
        <Routes>
          <Route path="/tasks" element={<TasksOverviewRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function mockFetch(opts: {
  jobs?: Record<string, unknown>
  outbox?: Record<string, unknown>
  schedules?: Record<string, unknown>
  a2a?: Record<string, unknown>
  heartbeat?: Record<string, unknown>
  asks?: Record<string, unknown>
} = {}) {
  const jobs = opts.jobs ?? {
    jobs: [],
    stats: { pending: 1, running: 2, completed: 10, failed: 0, delivered: 9 },
  }
  const outbox = opts.outbox ?? {
    pending: 0,
    delivered: 30,
    giving_up: 0,
    total: 30,
    lastDeliveredAt: null,
  }
  const schedules = opts.schedules ?? {
    schedules: [
      { id: 1, name: 'daily', agent: 'agim', prompt: 'check', cron: '0 9 * * *', enabled: true, next_run: '2026-07-01T09:00:00Z' },
    ],
  }
  const a2a = opts.a2a ?? {
    total: 8,
    recent24h: 3,
    maxDepth: 1,
    byStatus: [],
    byAgent: [],
  }
  const heartbeat = opts.heartbeat ?? {
    count: 1,
    bindings: [
      { platform: 'web', channelId: 'c', threadId: 't', userId: 'u', body: 'check', intervalMinutes: 60, enabled: true, lastTickAt: null, lastStatus: '', lastReason: '', lastTextPreview: '', createdAt: '2026-07-01T00:00:00Z' },
    ],
  }
  const asks = opts.asks ?? {
    count: 2,
    pending: [
      { reqId: 'ask_1', platform: 'web', threadId: 't', question: 'Pick one', choices: 2, ageMs: 1000 },
      { reqId: 'ask_2', platform: 'web', threadId: 't', question: 'Confirm', choices: 2, ageMs: 2000 },
    ],
  }

  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const u = String(input)
    if (u.startsWith('/api/jobs')) return jsonResponse(jobs)
    if (u === '/api/outbox/stats') return jsonResponse(outbox)
    if (u.startsWith('/api/schedules')) return jsonResponse(schedules)
    if (u === '/api/a2a/stats') return jsonResponse(a2a)
    if (u === '/api/heartbeat/bindings') return jsonResponse(heartbeat)
    if (u === '/api/asks/pending') return jsonResponse(asks)
    return jsonResponse({})
  })
}

describe('/tasks overview', () => {
  it('prioritizes pending human questions before other activity', async () => {
    mockFetch()
    renderPage()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Tasks overview' })).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('2 ask_user pending')).toBeInTheDocument())
    expect(screen.getByText('2 running · 1 pending')).toBeInTheDocument()
    expect(screen.getByText('1 schedules · 1 heartbeats')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Answer pending questions/i })).toHaveAttribute('href', '/tasks/asks')
  })

  it('routes stuck IM delivery to the outbox when no ask is pending', async () => {
    mockFetch({
      asks: { count: 0, pending: [] },
      outbox: { pending: 2, delivered: 30, giving_up: 1, total: 33, lastDeliveredAt: null },
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('1 stuck')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /Retry stuck deliveries/i })).toHaveAttribute('href', '/tasks/outbox')
  })
})
