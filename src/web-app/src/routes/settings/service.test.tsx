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
import { requireValue } from '@/test/assert'
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
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/settings/service']}>
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
  bootPhase: 'ready', bootMsSinceStart: 5000, bootPhaseTimings: {},
}
const STOPPED_STATUS = {
  mode: 'none', pid: null, uptimeSec: null, uptime: null,
  web: null, bootPhase: 'not-started', bootMsSinceStart: 0, bootPhaseTimings: {},
}
const LOG_TAIL = {
  path: '/Users/a/.agim/agim.log',
  exists: true,
  content: 'boot: starting\nChat UI available at http://127.0.0.1:3000',
  lines: 2,
  truncated: false,
  size: 128,
  mtime: '2026-06-30T12:00:00Z',
}
const MISSING_LOG = {
  path: '/Users/a/.agim/agim.log',
  exists: false,
  content: '',
  lines: 0,
  truncated: false,
  size: 0,
  mtime: null,
}

describe('/settings/service', () => {
  it('renders status when running; Start disabled, Stop+Restart enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input)
      if (u === '/api/service/status') return jsonResponse(RUNNING_STATUS)
      if (u.startsWith('/api/service/log-tail')) return jsonResponse(LOG_TAIL)
      if (u === '/api/config')         return jsonResponse({})
      return jsonResponse({})
    })
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
      if (u.startsWith('/api/service/log-tail')) return jsonResponse(LOG_TAIL)
      if (u === '/api/config')         return jsonResponse({})
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
    fireEvent.click(requireValue(destructive, 'service stop confirmation'))
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
      if (u.startsWith('/api/service/log-tail')) return jsonResponse(LOG_TAIL)
      if (u === '/api/config')         return jsonResponse({})
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

  it('shows the recovery card with recent logs and copyable commands', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input)
      if (u === '/api/service/status') return jsonResponse(RUNNING_STATUS)
      if (u.startsWith('/api/service/log-tail')) return jsonResponse(LOG_TAIL)
      if (u === '/api/config')         return jsonResponse({})
      return jsonResponse({})
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('Recovery')).toBeInTheDocument())
    expect(screen.getByText('Local doctor')).toBeInTheDocument()
    expect(screen.getByText('Service status')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('View log')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText(/Chat UI available/)).toBeInTheDocument())
    expect(screen.getByText('/Users/a/.agim/agim.log')).toBeInTheDocument()
  })

  it('does not offer a tail command before the service log exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input)
      if (u === '/api/service/status') return jsonResponse(STOPPED_STATUS)
      if (u.startsWith('/api/service/log-tail')) return jsonResponse(MISSING_LOG)
      if (u === '/api/config')         return jsonResponse({})
      return jsonResponse({})
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('Log not created yet')).toBeInTheDocument())
    expect(screen.queryByText('View log')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('No log file yet. It is created after the first background service start.')).toBeInTheDocument()
    })
  })
})
