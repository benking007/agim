/**
 * /memos smoke — verifies:
 *   * Search results render
 *   * Empty state on no results
 *   * Delete action → ConfirmDialog → DELETE /api/memos/:id
 *   * Memos with location surface a "Open map" dropdown
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { createWorkbenchQueryClient } from '@/test/query-client'
import MemosRoute from './memos'
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
  const qc = createWorkbenchQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/memos']}>
        <Routes>
          <Route path="/memos" element={<MemosRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const TWO_MEMOS = {
  memos: [
    {
      id: 1, platform: 'wechat', userId: 'u', what: 'tax docs',
      who: 'self', whenAt: null, whenText: 'next monday',
      where_lat: null, where_lng: null, where_label: null,
      how: null, why: null, memo: 'pick up tax docs from accountant',
      source: 'slash', expiresAt: null,
      createdAt: '2026-05-18T08:00:00Z', updatedAt: null,
    },
    {
      id: 2, platform: 'wechat', userId: 'u', what: 'meet alice',
      who: 'alice', whenAt: null, whenText: 'tomorrow 3pm',
      where_lat: 31.23, where_lng: 121.47, where_label: 'Pudong cafe',
      how: null, why: null, memo: null,
      source: 'slash', expiresAt: null,
      createdAt: '2026-05-18T07:00:00Z', updatedAt: null,
      mapUrls: {
        baidu:  'https://map.baidu.com/?l=31.23,121.47',
        google: 'https://maps.google.com/?q=31.23,121.47',
      },
    },
  ],
}

describe('/memos', () => {
  it('renders search results with memo + map cell', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(TWO_MEMOS))
    renderPage()
    await waitFor(() => {
      // Two memos visible (jsdom renders both desktop + mobile views)
      expect(screen.getAllByText('pick up tax docs from accountant').length).toBeGreaterThan(0)
    })
    // Location label appears as the map cell button text
    expect(screen.getAllByText('Pudong cafe').length).toBeGreaterThan(0)
  })

  it('empty results → friendly empty-state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ memos: [] }))
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('No memos match').length).toBeGreaterThan(0)
    })
  })

  it('Delete → ConfirmDialog → DELETE /api/memos/:id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.match(/^\/api\/memos\/\d+$/) && init?.method === 'DELETE') {
        return jsonResponse({ ok: true, id: 1 })
      }
      if (u.startsWith('/api/memos')) {
        return jsonResponse(TWO_MEMOS)
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('pick up tax docs from accountant').length).toBeGreaterThan(0)
    })
    // The desktop table has explicit Delete buttons (one per row).
    const table = screen.getByRole('table')
    const deleteBtns = within(table).getAllByRole('button', { name: 'Delete' })
    expect(deleteBtns.length).toBeGreaterThanOrEqual(1)
    const firstDelete = deleteBtns[0]
    if (!firstDelete) throw new Error('memo row Delete button must exist')
    fireEvent.click(firstDelete)
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
    // Inside dialog: two buttons share text "Delete" — the cancel
    // secondary + the destructive confirm. We want destructive.
    const dialog = screen.getByRole('dialog')
    const candidates = within(dialog).getAllByRole('button', { name: 'Delete' })
    const destructive = candidates.find((b) => b.className.includes('border-danger'))
    expect(destructive, 'destructive Delete button must exist').toBeDefined()
    if (!destructive) throw new Error('destructive Delete button must exist')
    fireEvent.click(destructive)
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => /^\/api\/memos\/\d+$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true)
    })
  })
})
