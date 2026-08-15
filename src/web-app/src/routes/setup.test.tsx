import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SetupRoute from './setup'
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

function renderSetup(path = '/setup'): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <Routes>
          <Route path="/setup" element={<SetupRoute />} />
          <Route path="/" element={<div>chat-home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function mockSetupFetch(opts: {
  firstRun?: boolean
  reason?: string
  skipped?: boolean
} = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input)
    const method = init?.method ?? 'GET'
    if (u === '/api/onboarding/status' && method === 'GET') {
      return jsonResponse({
        firstRun: opts.firstRun ?? true,
        reason: opts.reason ?? 'no-usable-agent',
        hasLlmSecret: false,
        availableCliAgents: [],
        defaultAgent: 'agim',
        skipped: opts.skipped ?? false,
      })
    }
    if (u === '/api/onboarding/skip' && method === 'POST') {
      return jsonResponse({
        firstRun: false,
        reason: 'no-usable-agent',
        hasLlmSecret: false,
        availableCliAgents: [],
        defaultAgent: 'agim',
        skipped: true,
      })
    }
    if (u === '/api/llm' && method === 'GET') {
      return jsonResponse({ backends: [], roles: {} })
    }
    if (u === '/api/llm/presets' && method === 'GET') {
      return jsonResponse({
        defaultPreset: 'deepseek',
        presets: [
          {
            key: 'deepseek',
            label: 'DeepSeek (recommended)',
            provider: 'openai-compat',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-v4-pro',
            baseName: 'deepseek-agim',
          },
          {
            key: 'custom',
            label: 'Custom',
            provider: 'openai-compat',
            baseUrl: '',
            model: '',
            baseName: 'agim-api',
          },
        ],
      })
    }
    if (u === '/api/config' && method === 'GET') {
      return jsonResponse({
        messengers: [],
        agents: ['agim'],
        defaultAgent: 'agim',
      })
    }
    return jsonResponse({ error: `unmocked ${method} ${u}` }, 404)
  })
}

describe('/setup wizard', () => {
  it('renders the welcome step and DeepSeek as recommended', async () => {
    mockSetupFetch()
    renderSetup()
    expect(await screen.findByRole('heading', { name: 'Welcome to Agim' })).toBeInTheDocument()
    expect(screen.getByText('Choose a model')).toBeInTheDocument()
    expect(screen.getByText('DeepSeek')).toBeInTheDocument()
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    expect(screen.getByText('Local Ollama')).toBeInTheDocument()
  })

  it('shows the completed state when onboarding is already ready', async () => {
    mockSetupFetch({ firstRun: false, reason: 'ready' })
    renderSetup()
    expect(await screen.findByRole('heading', { name: 'Setup is complete' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open chat/ })).toHaveAttribute('href', '/?welcome=1')
  })

  it('skip writes the skipped flag and leaves the wizard', async () => {
    const fetchSpy = mockSetupFetch()
    const user = userEvent.setup()
    renderSetup()
    await screen.findByRole('heading', { name: 'Welcome to Agim' })
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(([input, init]) => (
        String(input) === '/api/onboarding/skip' && (init?.method ?? 'GET') === 'POST'
      ))).toBe(true)
    })
    expect(await screen.findByText('chat-home')).toBeInTheDocument()
  })
})
