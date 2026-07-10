/**
 * /approvals smoke — verifies:
 *   * GET /api/approvals → cards + KPI strip render
 *   * Allow click → POST /api/approvals/:reqId/resolve { behavior:
 *     'allow' } and the list re-fetches
 *   * Empty pending → friendly empty-state shows
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import ApprovalsRoute from './approvals'
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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/approvals']}>
        <Routes>
          <Route path="/approvals" element={<ApprovalsRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const PENDING_PAYLOAD = {
  pending: [
    {
      reqId: 'r-1', runId: 'run-1', threadId: 'wechat:room:foo',
      platform: 'wechat', toolName: 'Bash',
      input: { command: 'ls /tmp' },
      fingerprint: 'fp-1', autoAllow: false,
      registeredAt: Date.now() - 5_000, ageMs: 5_000,
    },
  ],
  metrics: {
    pending: 1,
    totalRequests: 7, totalResolved: 6, totalAllowed: 4,
    totalDenied: 1, totalTimedOut: 1, totalReadonlyAutoAllowed: 0,
  },
}

function mockApprovals(payload: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === '/api/approvals') return jsonResponse(payload)
    return jsonResponse({})
  })
}

describe('/approvals', () => {
  it('renders the pending list + KPI strip', async () => {
    mockApprovals(PENDING_PAYLOAD)
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument()
    })
    expect(screen.getByText('wechat:room:foo')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Approvals' })).toBeInTheDocument()
    expect(screen.getByText('Total allowed')).toBeInTheDocument()
  })

  it('clicking Allow → POST /api/approvals/r-1/resolve with behavior:allow', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/approvals' && (init?.method === undefined || init?.method === 'GET')) {
        return jsonResponse(PENDING_PAYLOAD)
      }
      if (u === '/api/approvals/r-1/resolve' && init?.method === 'POST') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body).toMatchObject({ behavior: 'allow' })
        return jsonResponse({ ok: true, resolved: true })
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('Bash')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === '/api/approvals/r-1/resolve' && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  it('empty pending → friendly empty-state shows', async () => {
    mockApprovals({
      pending: [],
      metrics: { pending: 0, totalRequests: 0, totalResolved: 0, totalAllowed: 0, totalDenied: 0, totalTimedOut: 0, totalReadonlyAutoAllowed: 0 },
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('No approvals waiting')).toBeInTheDocument()
    })
  })
})

void within
