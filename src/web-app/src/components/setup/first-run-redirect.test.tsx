import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FirstRunRedirect } from './first-run-redirect'
import { MobileChatRedirect } from '@/components/chat/mobile-chat-redirect'
import '@/i18n'

function mockMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

function renderAt(
  path: string,
  status: { firstRun: boolean },
): ReturnType<typeof render> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const url = String(input)
    const body = url.includes('/api/onboarding/status')
      ? {
          firstRun: status.firstRun,
          reason: status.firstRun ? 'no-usable-agent' : 'ready',
          hasLlmSecret: !status.firstRun,
          availableCliAgents: [],
          defaultAgent: 'agim',
          skipped: false,
        }
      : {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <Routes>
          <Route
            path="/"
            element={(
              <FirstRunRedirect>
                <MobileChatRedirect>
                  <div>desktop-chat</div>
                </MobileChatRedirect>
              </FirstRunRedirect>
            )}
          />
          <Route
            path="/m/chat"
            element={(
              <FirstRunRedirect>
                <div>mobile-chat</div>
              </FirstRunRedirect>
            )}
          />
          <Route path="/setup" element={<div>setup-wizard</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('FirstRunRedirect', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    mockMatchMedia(false)
  })

  it('sends first-run visitors from / to /setup', async () => {
    renderAt('/', { firstRun: true })
    expect(await screen.findByText('setup-wizard')).toBeInTheDocument()
  })

  it('wins over the mobile chat redirect on a narrow viewport', async () => {
    mockMatchMedia(true)
    renderAt('/', { firstRun: true })
    expect(await screen.findByText('setup-wizard')).toBeInTheDocument()
    expect(screen.queryByText('mobile-chat')).not.toBeInTheDocument()
  })

  it('sends first-run visitors from /m/chat to /setup', async () => {
    renderAt('/m/chat', { firstRun: true })
    expect(await screen.findByText('setup-wizard')).toBeInTheDocument()
  })

  it('keeps chat when welcome=1 is present', async () => {
    renderAt('/?welcome=1', { firstRun: true })
    expect(await screen.findByText('desktop-chat')).toBeInTheDocument()
  })

  it('keeps chat when first-run is already done', async () => {
    renderAt('/', { firstRun: false })
    expect(await screen.findByText('desktop-chat')).toBeInTheDocument()
  })
})
