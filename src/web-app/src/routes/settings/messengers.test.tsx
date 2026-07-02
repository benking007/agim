import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import SettingsMessengersRoute from './messengers'
import '@/i18n'

beforeEach(() => {
  localStorage.setItem('agim_token', 'tok')
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
      <MemoryRouter initialEntries={['/settings/messengers']}>
        <Routes>
          <Route path="/settings/messengers" element={<SettingsMessengersRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function mockFetch(config: Record<string, unknown> = {}, service: Record<string, unknown> = {}) {
  const cfg = {
    messengers: [],
    agents: ['claude-code'],
    defaultAgent: 'claude-code',
    features: { globalIm: true, remoteAgent: true, blacklistedPlatforms: [] },
    ...config,
  }
  const serviceStatus = {
    mode: 'background',
    pid: 123,
    uptimeSec: 12,
    uptime: '12s',
    web: { bind: '127.0.0.1', port: 3000 },
    bootPhase: 'ready',
    bootMsSinceStart: 12000,
    bootPhaseTimings: {},
    ...service,
  }
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input)
    const method = init?.method ?? 'GET'
    if (u === '/api/config' && method === 'GET') return jsonResponse(cfg)
    if (u === '/api/config' && method === 'PUT') {
      Object.assign(cfg, JSON.parse(String(init.body)))
      return jsonResponse(cfg)
    }
    if (u === '/api/service/status' && method === 'GET') return jsonResponse(serviceStatus)
    if (u === '/api/service/restart' && method === 'POST') return jsonResponse({ ok: true, mode: 'background', pid: 456 })
    if (u === '/api/service/start' && method === 'POST') return jsonResponse({ ok: true, mode: 'background', pid: 456 })
    if (u === '/api/messengers/wechat/qr-start' && method === 'POST') {
      return jsonResponse({ qrToken: 'qr-token', qrImage: 'data:image/png;base64,AA==' })
    }
    if (u.startsWith('/api/messengers/wechat/qr-status')) {
      return jsonResponse({ status: 'pending' })
    }
    return jsonResponse({})
  })
}

describe('/settings/messengers quick connect', () => {
  it('lets a fresh user pick Feishu and reveals only the fields they need next', async () => {
    mockFetch()
    renderPage()

    await waitFor(() => expect(screen.getByText('Connect one messenger')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /configure feishu/i }))

    await waitFor(() => expect(screen.getByLabelText('App ID')).toBeInTheDocument())
    expect(screen.getByLabelText('App secret')).toBeInTheDocument()
    expect(screen.getByLabelText('Channel ID')).toBeInTheDocument()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(document.getElementById('messenger-feishu')).toHaveClass('ring-2')
    expect(screen.getByRole('button', { name: /save all/i })).toBeInTheDocument()
  })

  it('summarizes connected messengers and points back to Web chat', async () => {
    mockFetch({ messengers: ['wechat-ilink'] })
    renderPage()

    await waitFor(() => expect(screen.getByText('Messenger connected')).toBeInTheDocument())
    expect(screen.getByText('Connected: WeChat. Open Web chat to verify it, or add another messenger.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open chat/i })).toHaveAttribute('href', '/?welcome=1')
    expect(screen.getByRole('button', { name: /add another/i })).toBeInTheDocument()
  })

  it('offers one-click restart after saving messenger config', async () => {
    const fetchSpy = mockFetch()
    renderPage()

    await waitFor(() => expect(screen.getByText('Connect one messenger')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /configure feishu/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /save all/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /save all/i }))

    await waitFor(() => expect(screen.getByText('Apply IM changes')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /restart agim/i }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === '/api/service/restart' && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })
})
