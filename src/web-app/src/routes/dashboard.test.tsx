import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import DashboardRoute from './dashboard'
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
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<DashboardRoute />} />
          <Route path="/" element={<div>Chat route</div>} />
          <Route path="/settings/llm" element={<div>LLM route</div>} />
          <Route path="/settings/messengers" element={<div>IM route</div>} />
          <Route path="/settings/service" element={<div>Service route</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function mockFetch(opts: {
  config?: Record<string, unknown>
  agents?: Record<string, boolean>
  llm?: Record<string, unknown>
  service?: Record<string, unknown>
} = {}) {
  const config = opts.config ?? {
    messengers: [],
    agents: ['claude-code'],
    defaultAgent: 'claude-code',
    features: { globalIm: true, remoteAgent: true },
  }
  const agents = opts.agents ?? { 'claude-code': true }
  const llm = opts.llm ?? { backends: [], roles: {} }
  const service = opts.service ?? {
    mode: 'background',
    pid: 123,
    uptimeSec: 12,
    uptime: '12s',
    web: { bind: '127.0.0.1', port: 3000 },
    bootPhase: 'ready',
    bootMsSinceStart: 12000,
    bootPhaseTimings: {},
  }

  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const u = String(input)
    if (u === '/api/config') return jsonResponse(config)
    if (u === '/api/agents/status') return jsonResponse(agents)
    if (u === '/api/llm') return jsonResponse(llm)
    if (u === '/api/service/status') return jsonResponse(service)
    return jsonResponse({})
  })
}

describe('/dashboard', () => {
  it('summarizes a fresh Web-only setup without making model API look blocking', async () => {
    mockFetch()
    renderPage()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home workbench' })).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText((_text, el) => el?.textContent === '2/3 ready')).toBeInTheDocument())
    await waitFor(() => {
      expect(screen.getByText((_text, el) => el?.textContent === 'Default agent：claude-code')).toBeInTheDocument()
    })
    expect(screen.getByText('claude-code is online')).toBeInTheDocument()
    expect(screen.getByText('No model API yet; external agents can still run.')).toBeInTheDocument()
    expect(screen.getByText('No IM connected yet.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Connect one IM/i })).toHaveAttribute('href', '/settings/messengers')
    expect(screen.getByRole('link', { name: /Enable Agim Agent/i })).toHaveAttribute('href', '/settings/llm')
  })

  it('routes native-agent setups without a model API to the API page first', async () => {
    mockFetch({
      config: {
        messengers: [],
        agents: ['native'],
        defaultAgent: 'native',
        features: { globalIm: true, remoteAgent: true },
      },
      agents: { native: false },
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('Agim Agent needs a model API.')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /Configure Agim Agent API/i })).toHaveAttribute('href', '/settings/llm')
  })

  it('shows the ready state for a native-agent + IM setup', async () => {
    mockFetch({
      config: {
        messengers: ['wechat-ilink'],
        agents: ['native'],
        defaultAgent: 'native',
        features: { globalIm: true, remoteAgent: true },
      },
      agents: { native: true },
      llm: {
        backends: [
          {
            name: 'deepseek',
            provider: 'openai-compat',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_DEEPSEEK' },
          },
        ],
        roles: { 'native-chat': 'deepseek' },
      },
    })
    renderPage()

    await waitFor(() => expect(screen.getByText((_text, el) => el?.textContent === '3/3 ready')).toBeInTheDocument())
    expect(screen.getByText('agim is online')).toBeInTheDocument()
    expect(screen.getByText('Connected: WeChat')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Review task activity/i })).toHaveAttribute('href', '/tasks')
  })

  it('keeps collapsed workbench links styled after tooltip wrapping', async () => {
    localStorage.setItem('agim-workbench-sidebar-collapsed', '1')
    mockFetch()
    renderPage()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home workbench' })).toBeInTheDocument())

    const overview = screen.getByRole('link', { name: 'Global overview' })
    expect(overview.className).toContain('h-11')
    expect(overview.className).toContain('text-brand-600')
    expect(overview.className).not.toContain('({')
  })

  it('defaults the workbench sidebar to collapsed for new users', async () => {
    mockFetch()
    renderPage()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home workbench' })).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument()
    expect(screen.queryByText('Navigation panel')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Global overview' }).className).toContain('h-11')
  })

  it('keeps an explicit expanded workbench sidebar preference', async () => {
    localStorage.setItem('agim-workbench-sidebar-collapsed', '0')
    mockFetch()
    renderPage()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home workbench' })).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toBeInTheDocument()
    expect(screen.getByText('Navigation panel')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Global overview' }).className).not.toContain('h-11')
  })
})
