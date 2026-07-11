/**
 * /memory/facts smoke — verifies:
 *   * Without ?user= the page shows the "pick a user" empty state
 *     and does NOT call /api/memory/facts
 *   * With ?user=, GET /api/memory/facts fires; facts render with
 *     category badge + confidence
 *   * Delete row → ConfirmDialog → DELETE /api/memory/facts/:id
 *   * Bulk select + Delete selected → ConfirmDialog → DELETE
 *     /api/memory/facts (body has ids array)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { requireValue } from '@/test/assert'
import MemoryFactsRoute from './facts'
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

function renderAt(search: string): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[`/memory/facts${search}`]}>
        <Routes>
          <Route path="/memory/facts" element={<MemoryFactsRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const PAGE_OF_TWO = {
  total: 2,
  limit: 50,
  offset: 0,
  facts: [
    {
      id: 11, user_key: 'wechat:u1', what: 'prefers tea over coffee',
      who: '', when_text: '', where_label: '', why: '',
      category: 'preference', confidence: 0.85,
      last_referenced_at: 1700000000000, source: 'consolidate',
      created_at: 1700000000000,
    },
    {
      id: 12, user_key: 'wechat:u1', what: 'lives in Shanghai',
      who: '', when_text: '', where_label: '', why: '',
      category: 'profile', confidence: 0.95,
      last_referenced_at: 1700000000000, source: 'consolidate',
      created_at: 1700000000000,
    },
  ],
}

describe('/memory/facts', () => {
  it('without ?user → empty-state, no API call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderAt('')
    await waitFor(() => {
      expect(screen.getByText('Pick a user to view their memory')).toBeInTheDocument()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('with ?user → calls /api/memory/facts and renders rows', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(PAGE_OF_TWO))
    renderAt('?user=wechat%3Au1')
    await waitFor(() => {
      const table = screen.getByRole('table')
      expect(within(table).getByText('prefers tea over coffee')).toBeInTheDocument()
    })
    const url = String(fetchSpy.mock.calls[0]?.[0])
    expect(url).toContain('/api/memory/facts')
    expect(url).toContain('user_key=wechat%3Au1')
    // Category badge renders the i18n label, not the raw key.
    expect(within(screen.getByRole('table')).getByText('Preference')).toBeInTheDocument()
  })

  it('row Delete → ConfirmDialog → DELETE /api/memory/facts/:id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.match(/\/api\/memory\/facts\/11\?/) && init?.method === 'DELETE') {
        return jsonResponse({ ok: true, id: 11 })
      }
      if (u.startsWith('/api/memory/facts')) {
        return jsonResponse(PAGE_OF_TWO)
      }
      return jsonResponse({})
    })
    renderAt('?user=wechat%3Au1')
    await waitFor(() => {
      expect(screen.getAllByText('prefers tea over coffee').length).toBeGreaterThan(0)
    })
    const table = screen.getByRole('table')
    const rowDeletes = within(table).getAllByRole('button', { name: 'Delete' })
    expect(rowDeletes.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(requireValue(rowDeletes[0], 'first fact delete button'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')
    const candidates = within(dialog).getAllByRole('button', { name: 'Delete' })
    const destructive = candidates.find((b) => b.className.includes('border-danger'))
    expect(destructive).toBeDefined()
    fireEvent.click(requireValue(destructive, 'fact delete confirmation'))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => /\/api\/memory\/facts\/11\?/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true)
    })
  })

  it('bulk delete: select-all → Delete selected → DELETE /api/memory/facts body has ids[]', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.match(/^\/api\/memory\/facts\?/) && init?.method === 'DELETE') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body).toMatchObject({ ids: expect.arrayContaining([11, 12]) })
        return jsonResponse({ deleted: 2 })
      }
      if (u.startsWith('/api/memory/facts')) {
        return jsonResponse(PAGE_OF_TWO)
      }
      return jsonResponse({})
    })
    renderAt('?user=wechat%3Au1')
    await waitFor(() => {
      expect(screen.getAllByText('prefers tea over coffee').length).toBeGreaterThan(0)
    })
    // Select all
    const table = screen.getByRole('table')
    const selectAll = within(table).getByRole('checkbox', { name: 'Select all rows' })
    fireEvent.click(selectAll)
    // Bulk delete button appears
    const bulkBtn = await waitFor(() => screen.getByRole('button', { name: 'Delete selected' }))
    fireEvent.click(bulkBtn)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')
    const candidates = within(dialog).getAllByRole('button', { name: 'Delete selected' })
    const destructive = candidates.find((b) => b.className.includes('border-danger'))
    expect(destructive).toBeDefined()
    fireEvent.click(requireValue(destructive, 'bulk delete confirmation'))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => /^\/api\/memory\/facts\?/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true)
    })
  })
})
