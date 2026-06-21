/**
 * /settings/admins smoke — verifies:
 *   * Admin list renders from /api/admin-allowlist with configured badge
 *   * Known users render and grant-admin button posts to /api/admin-allowlist
 *   * Per-row Remove → ConfirmDialog → DELETE
 *   * Empty discovered list → friendly empty-state
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import SettingsAdminsRoute from './admins'
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
      <MemoryRouter initialEntries={['/settings/admins']}>
        <Routes>
          <Route path="/settings/admins" element={<SettingsAdminsRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const PAYLOAD = {
  admins: [{ platform: 'wechat', userId: 'wxid_alice' }],
  knownUsers: [
    {
      platform: 'wechat',
      userId: 'wxid_alice',
      firstSeenAt: '2026-06-21T12:00:00.000Z',
      lastSeenAt: '2026-06-21T12:30:00.000Z',
    },
    {
      platform: 'feishu',
      userId: 'ou_bob',
      firstSeenAt: '2026-06-21T12:01:00.000Z',
      lastSeenAt: '2026-06-21T12:31:00.000Z',
    },
  ],
  configured: true,
}

describe('/settings/admins', () => {
  it('renders admin rows + configured badge + known count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(PAYLOAD))
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('wxid_alice').length).toBeGreaterThan(0)
    })
    expect(screen.getByText('Allowlist configured')).toBeInTheDocument()
    expect(screen.getByText('Discovered users: 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Already admin' })).toBeDisabled()
  })

  it('Grant admin button posts to /api/admin-allowlist', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/admin-allowlist' && init?.method === 'POST') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body).toMatchObject({ platform: 'feishu', userId: 'ou_bob' })
        return jsonResponse({
          ok: true,
          added: true,
          admins: [...PAYLOAD.admins, { platform: 'feishu', userId: 'ou_bob' }],
        })
      }
      if (u === '/api/admin-allowlist') return jsonResponse(PAYLOAD)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getAllByText('wxid_alice').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Grant admin' }))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === '/api/admin-allowlist' && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  it('Remove → ConfirmDialog → DELETE', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/admin-allowlist' && init?.method === 'DELETE') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body).toMatchObject({ platform: 'wechat', userId: 'wxid_alice' })
        return jsonResponse({ ok: true, removed: true, admins: [] })
      }
      if (u === '/api/admin-allowlist') return jsonResponse(PAYLOAD)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getAllByText('wxid_alice').length).toBeGreaterThan(0))
    const rowRemoves = screen.getAllByRole('button', { name: 'Remove' })
    fireEvent.click(rowRemoves[0]!)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')
    const candidates = within(dialog).getAllByRole('button', { name: 'Remove' })
    const destructive = candidates.find((b) => b.className.includes('border-danger'))
    if (!destructive) throw new Error('destructive remove button not found')
    fireEvent.click(destructive)
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === '/api/admin-allowlist' && (c[1] as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true)
    })
  })

  it('empty list → friendly empty-state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      admins: [],
      knownUsers: [],
      configured: false,
    }))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('No discovered IM users yet.')).toBeInTheDocument()
    })
  })
})
