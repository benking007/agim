/**
 * /tasks/outbox smoke — verifies rows + stats render, Retry button
 * appears only for `giving_up` rows, clicking it opens the
 * ConfirmDialog and confirms route the retry POST through
 * useRetryOutbox.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import OutboxRoute from './outbox'
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/tasks/outbox']}>
        <Routes>
          <Route path="/tasks/outbox" element={<OutboxRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const TWO_ROWS = {
  rows: [
    { id: 1, job_id: 10, thread_key: 'wechat:chat:a', platform: 'wechat', channel_id: 'c', thread_id: 't', payload: 'p1', kind: 'text', priority: 'normal', status: 'pending', attempts: 0, last_attempt_at: null, last_error: null, delivered_at: null, next_attempt_at: '2026-05-18T09:00:00Z', created_at: '2026-05-18T08:00:00Z' },
    { id: 2, job_id: 11, thread_key: 'feishu:chat:b', platform: 'feishu', channel_id: 'c', thread_id: 't', payload: 'p2', kind: 'text', priority: 'normal', status: 'giving_up', attempts: 5, last_attempt_at: '2026-05-18T08:50:00Z', last_error: 'rate limited', delivered_at: null, next_attempt_at: null, created_at: '2026-05-18T07:00:00Z' },
  ],
}
const STATS = { pending: 1, delivered: 100, giving_up: 1, total: 102, lastDeliveredAt: '2026-05-18T07:55:00Z' }

describe('/tasks/outbox', () => {
  it('renders rows + stats, Retry only on giving_up rows', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/api/outbox/stats')) return jsonResponse(STATS)
      if (u.startsWith('/api/outbox')) return jsonResponse(TWO_ROWS)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).getByText('wechat:chat:a')).toBeInTheDocument()
    })
    const table = screen.getByRole('table')
    expect(within(table).getByText('feishu:chat:b')).toBeInTheDocument()
    expect(within(table).getByText('rate limited')).toBeInTheDocument()

    // Retry button only for #2 (giving_up).
    const retryBtns = within(table).getAllByRole('button', { name: 'Retry' })
    expect(retryBtns).toHaveLength(1)

    // Stats KPI cards visible — KPI labels share text with the
    // status-badge variants on rows of matching status, so use
    // getAllByText (presence, not uniqueness, is what we want).
    expect(screen.getAllByText('Pending').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Giving up').length).toBeGreaterThanOrEqual(1)
  })

  it('Retry → confirm dialog opens; confirming POSTs to /api/outbox/:id/retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.includes('/api/outbox/stats')) return jsonResponse(STATS)
      if (u.startsWith('/api/outbox/2/retry') && init?.method === 'POST') {
        return jsonResponse({ ok: true, id: 2 })
      }
      if (u.startsWith('/api/outbox')) return jsonResponse(TWO_ROWS)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).getByText('feishu:chat:b')).toBeInTheDocument()
    })
    // Click row #2's Retry — opens the ConfirmDialog.
    const retryBtn = within(screen.getByRole('table')).getByRole('button', { name: 'Retry' })
    fireEvent.click(retryBtn)
    // Wait for the dialog (title rendered into a portal).
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
    // The dialog confirm button (label overridden to "Retry") sits
    // inside the dialog; the row-action one stays outside.
    const dialog = screen.getByRole('dialog')
    const confirmBtn = within(dialog).getByRole('button', { name: 'Retry' })
    fireEvent.click(confirmBtn)
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]).startsWith('/api/outbox/2/retry') && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })
})
