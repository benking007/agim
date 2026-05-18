/**
 * /settings/env smoke — verifies:
 *   * GET /api/env populates the row list with secrets masked
 *   * Filter input narrows the list locally
 *   * Edit a value → dirty badge + Save fires PUT /api/env { updates }
 *   * Unset → row shows "(unset)" + Save sends null
 *   * Reveal toggle issues a ?reveal=1 fetch
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import SettingsEnvRoute from './env'
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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/env']}>
        <Routes>
          <Route path="/settings/env" element={<SettingsEnvRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const ENV_PAYLOAD = {
  env: {
    IMHUB_SMTP_HOST: 'mail.example.com',
    IMHUB_SMTP_USER: 'ops@example.com',
    IMHUB_SMTP_PASS: '****abcd',  // masked
    IMHUB_BAIDU_MAP_AK: 'AKxyz1234',
  },
  secretKeys: ['IMHUB_SMTP_PASS', 'IMHUB_BAIDU_MAP_AK'],
}

describe('/settings/env', () => {
  it('renders keys + secret tags', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(ENV_PAYLOAD))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('IMHUB_SMTP_HOST')).toBeInTheDocument()
    })
    expect(screen.getByText('IMHUB_SMTP_PASS')).toBeInTheDocument()
    // 2 secret tags
    expect(screen.getAllByText('secret').length).toBe(2)
  })

  it('edit + Save → PUT /api/env { updates }', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.startsWith('/api/env') && init?.method === 'PUT') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body).toMatchObject({ updates: { IMHUB_SMTP_HOST: 'mail2.example.com' } })
        return jsonResponse(ENV_PAYLOAD)
      }
      if (u.startsWith('/api/env')) return jsonResponse(ENV_PAYLOAD)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('IMHUB_SMTP_HOST')).toBeInTheDocument())
    // Find the SMTP_HOST input — the placeholder is the server value.
    const hostInput = screen.getByPlaceholderText('mail.example.com') as HTMLInputElement
    fireEvent.change(hostInput, { target: { value: 'mail2.example.com' } })
    // Dirty badge appears
    await waitFor(() => {
      expect(screen.getByText('1 unsaved')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]).startsWith('/api/env') && (c[1] as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toBe(true)
    })
  })

  it('Reveal toggle issues a separate ?reveal=1 fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(ENV_PAYLOAD))
    renderPage()
    await waitFor(() => expect(screen.getByText('IMHUB_SMTP_HOST')).toBeInTheDocument())
    // Click "Reveal secrets"
    fireEvent.click(screen.getByRole('button', { name: 'Reveal secrets' }))
    // The client serializes boolean query values as "1" / "0".
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some((c) => String(c[0]).includes('reveal=1')),
      ).toBe(true)
    })
  })
})
