import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { requireValue } from '@/test/assert'

import SettingsLlmRoute from './llm'
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
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/settings/llm']}>
        <Routes>
          <Route path="/settings/llm" element={<SettingsLlmRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

interface BackendRow {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  secret: { source: 'file' | 'none'; envKey: string }
}

function mockLlmFetch(opts: {
  backends?: BackendRow[]
  roles?: Record<string, string>
  config?: Record<string, unknown>
  pingResponse?: Record<string, unknown>
} = {}) {
  const backends = opts.backends ?? []
  const roles = { ...(opts.roles ?? {}) }
  const config = {
    messengers: [],
    agents: ['claude-code'],
    defaultAgent: 'claude-code',
    features: { globalIm: true, remoteAgent: true },
    ...(opts.config ?? {}),
  }

  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input)
    const method = init?.method ?? 'GET'
    if (u === '/api/llm' && method === 'GET') {
      return jsonResponse({ backends, roles })
    }
    if (u === '/api/config' && method === 'GET') {
      return jsonResponse(config)
    }
    if (u === '/api/llm/backends' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        name: string
        provider: 'openai-compat' | 'anthropic'
        baseUrl: string
        model: string
      }
      backends.push({
        ...body,
        secret: { source: 'file', envKey: `AGIM_LLM_SECRET_${body.name.toUpperCase()}` },
      })
      return jsonResponse({ name: body.name, secretStored: true }, 201)
    }
    if (u === '/api/llm/quick-enable' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        name?: string
        model?: string
        baseUrl?: string
        apiKey?: string
        preset?: string
      }
      const name = body.name?.trim() || 'deepseek-agim'
      const model = body.model?.trim() || 'deepseek-v4-pro'
      const baseUrl = body.baseUrl?.trim() || 'https://api.deepseek.com'
      const flashName = 'deepseek-agim-flash'
      backends.push({
        name,
        provider: 'openai-compat',
        baseUrl,
        model,
        secret: { source: 'file', envKey: `AGIM_LLM_SECRET_${name.toUpperCase()}` },
      })
      backends.push({
        name: flashName,
        provider: 'openai-compat',
        baseUrl,
        model: 'deepseek-v4-flash',
        secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_DEEPSEEK_AGIM_FLASH' },
      })
      Object.assign(roles, {
        'native-chat': name,
        cheap: flashName,
        evaluator: flashName,
      })
      config.defaultAgent = 'agim'
      if (!Array.isArray(config.agents)) config.agents = []
      if (!(config.agents as string[]).includes('agim')) (config.agents as string[]).push('agim')
      return jsonResponse({
        name,
        provider: 'openai-compat',
        baseUrl,
        model,
        backends: [
          { name, model },
          { name: flashName, model: 'deepseek-v4-flash' },
        ],
        roles: { ...roles },
        defaultAgent: 'agim',
        preset: body.preset || 'deepseek',
      }, 201)
    }
    if (u === '/api/llm/roles' && method === 'PUT') {
      Object.assign(roles, JSON.parse(String(init.body)))
      return jsonResponse({ roles })
    }
    if (u === '/api/config' && method === 'PUT') {
      Object.assign(config, JSON.parse(String(init.body)))
      return jsonResponse({ ok: true })
    }
    if (u === '/api/llm/backends/deepseek-agim/ping' && method === 'POST') {
      return jsonResponse(opts.pingResponse ?? {
        name: 'deepseek-agim',
        ok: true,
        durationMs: 123,
        tokensIn: 3,
        tokensOut: 2,
        sampleText: 'pong',
      })
    }
    return jsonResponse({})
  })
}

describe('/settings/llm quick setup', () => {
  it('adds a model API, binds native-chat, sets agim as default, then pings', async () => {
    const fetchSpy = mockLlmFetch()
    renderPage()

    await waitFor(() => expect(screen.getByText('Quick-enable Agim Agent')).toBeInTheDocument())
    fireEvent.change(requireValue(screen.getAllByPlaceholderText('sk-...')[0], 'API key input'), {
      target: { value: 'sk-test' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save and test/i }))

    await waitFor(() => expect(screen.getByText('Agim Agent is ready')).toBeInTheDocument())
    expect(screen.getByText('Currently using deepseek-agim. Open Web chat to test it.')).toBeInTheDocument()

    const quickCall = fetchSpy.mock.calls.find(
      (c) => String(c[0]) === '/api/llm/quick-enable' && (c[1] as RequestInit | undefined)?.method === 'POST',
    )
    expect(quickCall).toBeDefined()
    const quickRequest = requireValue(quickCall?.[1] as RequestInit | undefined, 'quick-enable request')
    expect(JSON.parse(String(quickRequest.body))).toEqual({
      preset: 'deepseek',
      apiKey: 'sk-test',
    })
    expect(
      fetchSpy.mock.calls.some(
        (c) => String(c[0]) === '/api/llm/backends/deepseek-agim/ping'
          && (c[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(true)
  })

  it('hides name/model/baseUrl for the default preinstalled provider', async () => {
    mockLlmFetch()
    renderPage()

    await waitFor(() => expect(screen.getByText('Quick-enable Agim Agent')).toBeInTheDocument())
    expect(screen.getByPlaceholderText('sk-...')).toBeInTheDocument()
    expect(screen.getByText(/Registers preinstalled models deepseek-v4-pro/i)).toBeInTheDocument()
    // Custom-only fields stay hidden until Custom is selected.
    expect(screen.queryByPlaceholderText('e.g. deepseek-cheap')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('model-id')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('https://api.example.com/v1')).not.toBeInTheDocument()
  })

  it('enables an existing usable API without asking for another key', async () => {
    const fetchSpy = mockLlmFetch({
      backends: [
        {
          name: 'deepseek-agim',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_DEEPSEEK_AGIM' },
        },
      ],
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('needs enable')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /enable agim agent/i }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === '/api/llm/roles'
            && (c[1] as RequestInit | undefined)?.method === 'PUT'
            && JSON.parse(String((c[1] as RequestInit).body))['native-chat'] === 'deepseek-agim',
        ),
      ).toBe(true)
    })
    expect(
      fetchSpy.mock.calls.some(
        (c) => String(c[0]) === '/api/config'
          && (c[1] as RequestInit | undefined)?.method === 'PUT'
          && JSON.parse(String((c[1] as RequestInit).body)).defaultAgent === 'agim',
      ),
    ).toBe(true)
  })

  it('keeps multi-api and runtime controls behind an advanced toggle', async () => {
    mockLlmFetch({
      backends: [
        {
          name: 'deepseek-agim',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_DEEPSEEK_AGIM' },
        },
      ],
      roles: { 'native-chat': 'deepseek-agim' },
      config: { defaultAgent: 'agim' },
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('Next: send one message')).toBeInTheDocument())
    expect(screen.queryByText('Agim Agent runtime settings')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show advanced settings/i }))

    expect(await screen.findByText('APIs (1)')).toBeInTheDocument()
    expect(screen.getByText('Role Bindings (optional, advanced)')).toBeInTheDocument()
    expect(screen.getByText('Agim Agent runtime settings')).toBeInTheDocument()
  })

  it('opens a details dialog when the quick probe fails', async () => {
    mockLlmFetch({
      pingResponse: {
        name: 'deepseek-agim',
        ok: false,
        durationMs: 80,
        error: 'HTTP 400 from openai-compat: {"error":{"message":"`temperature` is deprecated for this model."}}',
      },
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('Quick-enable Agim Agent')).toBeInTheDocument())
    fireEvent.change(requireValue(screen.getAllByPlaceholderText('sk-...')[0], 'API key input'), {
      target: { value: 'sk-test' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save and test/i }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: /probe failed/i })).toBeInTheDocument())
    expect(screen.getByText(/does not accept the temperature parameter/i)).toBeInTheDocument()
    expect(screen.getByText(/temperature.*deprecated/i)).toBeInTheDocument()
  })
})
