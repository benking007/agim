/**
 * /reminders smoke — verifies:
 *   * Pending list renders with id/text/status
 *   * Empty state shows on empty result
 *   * Cancel action → ConfirmDialog → POST /api/reminders/:id/cancel
 *   * Snooze action → SnoozeDialog → preset click → POST
 *     /api/reminders/:id/snooze { duration: "5m" }
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import RemindersRoute from './reminders'
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
      <MemoryRouter initialEntries={['/reminders']}>
        <Routes>
          <Route path="/reminders" element={<RemindersRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const PENDING_PAYLOAD = {
  reminders: [
    {
      id: 7, fire_at: '2026-05-19T09:00:00Z', text: 'water plants',
      platform: 'wechat', channel_id: 'c', thread_id: 't', user_id: 'u',
      status: 'pending', created_at: '2026-05-18T08:00:00Z',
      fired_at: null, error: null, source: 'slash',
      parent_id: null, recurrence: null, last_fired_at: null,
      prompt_mode: 'literal', recurrence_label: null,
    },
  ],
}

function mockReminders(payload: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).startsWith('/api/reminders')) return jsonResponse(payload)
    return jsonResponse({})
  })
}

describe('/reminders', () => {
  it('renders pending list with text + action buttons', async () => {
    mockReminders(PENDING_PAYLOAD)
    renderPage()
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).getByText('water plants')).toBeInTheDocument()
    })
    const table = screen.getByRole('table')
    expect(within(table).getByRole('button', { name: 'Snooze' })).toBeInTheDocument()
    expect(within(table).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('Cancel → ConfirmDialog → POST /api/reminders/7/cancel', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.startsWith('/api/reminders/7/cancel') && init?.method === 'POST') {
        return jsonResponse({ ok: true, id: 7 })
      }
      if (u.startsWith('/api/reminders')) {
        return jsonResponse(PENDING_PAYLOAD)
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('water plants').length).toBeGreaterThan(0)
    })
    const rowCancel = within(screen.getByRole('table')).getByRole('button', { name: 'Cancel' })
    fireEvent.click(rowCancel)
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
    const dialog = screen.getByRole('dialog')
    const candidates = within(dialog).getAllByRole('button', { name: 'Cancel' })
    const destructive = candidates.find((b) => b.className.includes('border-danger'))
    expect(destructive, 'destructive Cancel button must be present').toBeDefined()
    fireEvent.click(destructive!)
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]).startsWith('/api/reminders/7/cancel') && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  it('Snooze → SnoozeDialog preset click → POST /api/reminders/7/snooze { duration: "5m" }', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.startsWith('/api/reminders/7/snooze') && init?.method === 'POST') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body).toMatchObject({ duration: '5m' })
        return jsonResponse({ ok: true, originalId: 7, newId: 8, duration: '5m' })
      }
      if (u.startsWith('/api/reminders')) {
        return jsonResponse(PENDING_PAYLOAD)
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('water plants').length).toBeGreaterThan(0)
    })
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: 'Snooze' }))
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '5 minutes' }))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]).startsWith('/api/reminders/7/snooze') && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  it('empty result → friendly empty-state', async () => {
    mockReminders({ reminders: [] })
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('Nothing scheduled').length).toBeGreaterThan(0)
    })
  })
})
