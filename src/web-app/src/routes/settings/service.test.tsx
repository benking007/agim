/**
 * /settings/service smoke — verifies:
 *   * Status renders (mode badge + pid + uptime + web endpoint)
 *   * Start enabled only when mode=none; Stop/Restart only when
 *     mode!=none
 *   * Stop → ConfirmDialog → POST /api/service/stop
 *   * Start → no dialog → POST /api/service/start
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import SettingsServiceRoute from './service'
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
      <MemoryRouter initialEntries={['/settings/service']}>
        <Routes>
          <Route path="/settings/service" element={<SettingsServiceRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const RUNNING_STATUS = {
  mode: 'systemd', pid: 12345, uptimeSec: 3600, uptime: '1h 0m',
  web: { bind: '127.0.0.1', port: 3000 },
  bootPhase: 'ready', bootMsSinceStart: 5000, bootPhaseTimings: { acp: 1200 },
}
const STOPPED_STATUS = {
  mode: 'none', pid: null, uptimeSec: null, uptime: null,
  web: null, bootPhase: 'not-started', bootMsSinceStart: 0, bootPhaseTimings: {},
}

describe('/settings/service', () => {
  it('renders status when running; Start disabled, Stop+Restart enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(RUNNING_STATUS))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('systemd')).toBeInTheDocument()
    })
    expect(screen.getByText('12345')).toBeInTheDocument()
    expect(screen.getByText('1h 0m')).toBeInTheDocument()
    expect(screen.getByText('127.0.0.1:3000')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Restart' })).not.toBeDisabled()
  })

  it('Stop → ConfirmDialog → POST /api/service/stop', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/service/stop' && init?.method === 'POST') {
        return jsonResponse({ ok: true })
      }
      if (u === '/api/service/status') return jsonResponse(RUNNING_STATUS)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('systemd')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')
    const candidates = within(dialog).getAllByRole('button', { name: 'Stop' })
    const destructive = candidates.find((b) => b.className.includes('border-danger'))
    expect(destructive).toBeDefined()
    fireEvent.click(destructive!)
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === '/api/service/stop' && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  it('mode=none → Start enabled; clicking it POSTs without confirm', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/service/start' && init?.method === 'POST') {
        return jsonResponse({ ok: true, mode: 'background', pid: 9999 })
      }
      if (u === '/api/service/status') return jsonResponse(STOPPED_STATUS)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('not running')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === '/api/service/start' && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })
})
