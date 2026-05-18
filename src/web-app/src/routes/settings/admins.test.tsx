/**
 * /settings/admins smoke — verifies:
 *   * Admin list renders from /api/admin-allowlist with the
 *     configured / bootstrap badges
 *   * Add form posts to /api/admin-allowlist
 *   * Per-row Remove → ConfirmDialog → DELETE
 *   * Empty list → friendly empty-state
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
  admins: [
    { platform: 'wechat', userId: 'wxid_alice' },
    { platform: 'feishu', userId: 'ou_bob' },
  ],
  configured: true,
  bootstrapAvailable: true,
  bootstrapTokenPath: '/root/.agim/bootstrap-token.txt',
}

describe('/settings/admins', () => {
  it('renders admin rows + configured badge', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(PAYLOAD))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('wxid_alice')).toBeInTheDocument()
    })
    expect(screen.getByText('ou_bob')).toBeInTheDocument()
    expect(screen.getByText('Allowlist configured')).toBeInTheDocument()
    expect(screen.getByText('Bootstrap token file present')).toBeInTheDocument()
  })

  it('Add form posts to /api/admin-allowlist', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/admin-allowlist' && init?.method === 'POST') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body).toMatchObject({ platform: 'telegram', userId: '12345' })
        return jsonResponse({
          ok: true, added: true,
          admins: [...PAYLOAD.admins, { platform: 'telegram', userId: '12345' }],
        })
      }
      if (u === '/api/admin-allowlist') return jsonResponse(PAYLOAD)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('wxid_alice')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'telegram' } })
    fireEvent.change(screen.getByLabelText('User ID'), { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
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
        return jsonResponse({ ok: true, admins: [PAYLOAD.admins[1]] })
      }
      if (u === '/api/admin-allowlist') return jsonResponse(PAYLOAD)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('wxid_alice')).toBeInTheDocument())
    const rowRemoves = screen.getAllByRole('button', { name: 'Remove' })
    fireEvent.click(rowRemoves[0]!)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')
    const candidates = within(dialog).getAllByRole('button', { name: 'Remove' })
    const destructive = candidates.find((b) => b.className.includes('border-danger'))
    expect(destructive).toBeDefined()
    fireEvent.click(destructive!)
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
      admins: [], configured: false, bootstrapAvailable: false, bootstrapTokenPath: '',
    }))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('No admins added yet.')).toBeInTheDocument()
    })
  })
})
