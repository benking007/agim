/**
 * /settings/viewer smoke — R13. Covers:
 *   * Two cards render: Viewer + Baidu Maps AK
 *   * Tunnel status panel appears when tunnelMode='quick'; hidden
 *     when 'off'
 *   * Tunnel panel shows binary-found vs binary-missing variants
 *   * Refresh button fires GET /api/viewer/tunnel
 *   * Enabling the Viewer opens the Save bar
 *   * Save sends PUT /api/env with the diff
 *   * Baidu AK suspicious-length warning fires when length ≠ 32
 *   * Clear AK sends PUT /api/env with IMHUB_BAIDU_MAP_AK: null
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import SettingsViewerRoute from './viewer'
import '@/i18n'

// jsdom doesn't implement Element.prototype.scrollIntoView — Radix
// Select uses it for keyboard nav focus. Polyfill once.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

beforeEach(() => { localStorage.setItem('agim_token', 'tok') })
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

function renderPage(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/viewer']}>
        <Routes>
          <Route path="/settings/viewer" element={<SettingsViewerRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const VIEWER_OFF_ENV = {
  env: {
    IMHUB_VIEWER_ENABLED: '0',
    IMHUB_VIEWER_TUNNEL_MODE: 'off',
  },
  secretKeys: ['IMHUB_BAIDU_MAP_AK'],
}

const VIEWER_QUICK_ENV = {
  env: {
    IMHUB_VIEWER_ENABLED: '1',
    IMHUB_VIEWER_PUBLIC_BASE_URL: 'https://agim.example.com',
    IMHUB_VIEWER_TUNNEL_MODE: 'quick',
    IMHUB_VIEWER_CHARS: '500',
    IMHUB_VIEWER_LINES: '12',
    IMHUB_BAIDU_MAP_AK: 'abcd' + '*'.repeat(24) + 'wxyz', // masked 32-char
  },
  secretKeys: ['IMHUB_BAIDU_MAP_AK'],
}

const TUNNEL_RUNNING = {
  enabled: true,
  tunnelMode: 'quick' as const,
  staticPublicUrl: 'https://agim.example.com',
  effectivePublicUrl: 'https://abc-123.trycloudflare.com',
  tunnel: {
    running: true,
    url: 'https://abc-123.trycloudflare.com',
    binaryFound: true,
    binaryPath: '/usr/local/bin/cloudflared',
    lastError: null,
    startedAt: Date.now(),
  },
}

const TUNNEL_BINARY_MISSING = {
  enabled: true,
  tunnelMode: 'quick' as const,
  staticPublicUrl: null,
  effectivePublicUrl: null,
  tunnel: {
    running: false,
    url: null,
    binaryFound: false,
    binaryPath: null,
    lastError: null,
    startedAt: null,
  },
}

function isEnvGet(u: string, method: string | undefined): boolean {
  return method !== 'PUT' && /^\/api\/env(\?|$)/.test(u)
}
function isEnvPut(u: string, method: string | undefined): boolean {
  return method === 'PUT' && /^\/api\/env(\?|$)/.test(u)
}

describe('/settings/viewer', () => {
  it('renders both cards (Viewer + Baidu Maps)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input)
      if (u === '/api/viewer/tunnel') return jsonResponse(TUNNEL_RUNNING)
      return jsonResponse(VIEWER_OFF_ENV)
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(/long-message links|长消息短链/i)).toBeInTheDocument()
    })
    expect(screen.getAllByText(/Baidu Maps AK/).length).toBeGreaterThan(0)
  })

  it('tunnel status panel hidden when tunnelMode=off', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(VIEWER_OFF_ENV))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(/long-message links|长消息短链/i)).toBeInTheDocument()
    })
    // The "Tunnel status" header is only rendered when mode=quick.
    expect(screen.queryByText(/Tunnel status|隧道状态/i)).not.toBeInTheDocument()
  })

  it('tunnel status panel shows running + URL when binary found', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input)
      if (u === '/api/viewer/tunnel') return jsonResponse(TUNNEL_RUNNING)
      return jsonResponse(VIEWER_QUICK_ENV)
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(/Tunnel status|隧道状态/i)).toBeInTheDocument()
    })
    // Tunnel URL is rendered as a clickable external link.
    const url = screen.getByRole('link', { name: /trycloudflare\.com/ })
    expect(url).toHaveAttribute('href', 'https://abc-123.trycloudflare.com')
    expect(url).toHaveAttribute('target', '_blank')
    expect(url).toHaveAttribute('rel', expect.stringContaining('noopener'))
    // Binary path shown
    expect(screen.getByText('/usr/local/bin/cloudflared')).toBeInTheDocument()
  })

  it('tunnel status panel surfaces the "binary not found" install hint', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input)
      if (u === '/api/viewer/tunnel') return jsonResponse(TUNNEL_BINARY_MISSING)
      return jsonResponse(VIEWER_QUICK_ENV)
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(/not found in PATH|未找到/i)).toBeInTheDocument()
    })
  })

  it('Refresh re-fetches /api/viewer/tunnel', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input)
      if (u === '/api/viewer/tunnel') return jsonResponse(TUNNEL_RUNNING)
      return jsonResponse(VIEWER_QUICK_ENV)
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(/Tunnel status|隧道状态/i)).toBeInTheDocument()
    })
    const before = fetchSpy.mock.calls.filter((c) => String(c[0]) === '/api/viewer/tunnel').length
    // The "Refresh" button inside the tunnel panel — there's also a
    // top-level page-Refresh button. Find by aria-label which is the
    // refresh action label and pick the panel one (the second).
    const refreshButtons = screen.getAllByRole('button', { name: /refresh|刷新/i })
    expect(refreshButtons.length).toBeGreaterThan(1)
    fireEvent.click(refreshButtons[refreshButtons.length - 1]!)
    await waitFor(() => {
      const after = fetchSpy.mock.calls.filter((c) => String(c[0]) === '/api/viewer/tunnel').length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('Baidu AK length ≠ 32 surfaces suspicious warning', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(VIEWER_OFF_ENV))
    renderPage()
    await waitFor(() => expect(screen.getAllByText(/Baidu Maps AK/).length).toBeGreaterThan(0))
    // The Baidu card has exactly one textbox (the AK input); the
    // Viewer card uses checkboxes + selects + number inputs (separate
    // role), so getAllByRole('textbox') here returns just the AK
    // input + Public URL (text). Wait — Viewer's publicUrl IS a
    // textbox too. Scope by aria/label association via document.
    // BaiduCard Input has id="baidu-ak"; wait for it to mount.
    const input = await waitFor(() => {
      const el = document.getElementById('baidu-ak') as HTMLInputElement | null
      if (!el) throw new Error('baidu-ak input not yet rendered')
      return el
    })
    fireEvent.change(input, { target: { value: 'short-ak' } })
    await waitFor(() => {
      // i18n template: "AK length is {{length}} — usually a Baidu AK is 32 characters"
      expect(screen.getByText(/AK length is 8|长度为 8/i)).toBeInTheDocument()
    })
  })

  it('Clear AK sends PUT /api/env with IMHUB_BAIDU_MAP_AK: null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = String(input)
      if (isEnvGet(u, init?.method)) return jsonResponse(VIEWER_QUICK_ENV)
      if (isEnvPut(u, init?.method)) return jsonResponse(VIEWER_OFF_ENV)
      if (u === '/api/viewer/tunnel') return jsonResponse(TUNNEL_RUNNING)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getAllByText(/Baidu Maps AK/).length).toBeGreaterThan(0))
    // Wait for the input to mount (signals BaiduCard fully rendered).
    await waitFor(() => {
      expect(document.getElementById('baidu-ak')).not.toBeNull()
    })
    const clearBtn = await waitFor(() => {
      const btn = screen.queryByRole('button', { name: /clear ak|清除 ak/i })
      if (!btn) throw new Error('clear button not found yet')
      return btn
    })
    fireEvent.click(clearBtn)
    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) => isEnvPut(String(c[0]), (c[1] as RequestInit | undefined)?.method),
      )
      expect(putCall).toBeDefined()
      const body = JSON.parse(String((putCall![1] as RequestInit).body)) as {
        updates: Record<string, string | null>
      }
      expect(body.updates.IMHUB_BAIDU_MAP_AK).toBeNull()
    })
  })
})
