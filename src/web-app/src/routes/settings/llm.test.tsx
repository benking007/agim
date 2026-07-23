import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { requireValue } from '@/test/assert'

import SettingsLlmRoute, { SettingsLlmPanel } from './llm'
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
  label?: string
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
            cheapModel: 'deepseek-v4-flash',
            models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
            baseName: 'deepseek-agim',
            defaultThinking: 'high',
          },
          {
            key: 'moonshot',
            label: 'Kimi',
            provider: 'openai-compat',
            baseUrl: 'https://api.moonshot.cn/v1',
            model: 'kimi-k3',
            cheapModel: 'kimi-k2.6',
            models: ['kimi-k3', 'kimi-k2.6'],
            baseName: 'kimi-agim',
            defaultThinking: 'high',
          },
          {
            key: 'zhipu',
            label: 'GLM',
            provider: 'openai-compat',
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            model: 'glm-5.2',
            cheapModel: 'glm-4.7-flash',
            models: ['glm-5.2', 'glm-4.7-flash'],
            baseName: 'glm-agim',
            defaultThinking: 'high',
          },
          {
            key: 'mimo',
            label: 'MiMo',
            provider: 'openai-compat',
            baseUrl: 'https://api.xiaomimimo.com/v1',
            model: 'mimo-v2.5-pro',
            cheapModel: 'mimo-v2.5',
            models: ['mimo-v2.5-pro', 'mimo-v2.5'],
            baseName: 'mimo-agim',
            defaultThinking: 'high',
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
      const name = body.name?.trim() || 'deepseek-v4-pro'
      const model = body.model?.trim() || 'deepseek-v4-pro'
      const baseUrl = body.baseUrl?.trim() || 'https://api.deepseek.com'
      const flashName = 'deepseek-v4-flash'
      backends.push({
        name,
        provider: 'openai-compat',
        baseUrl,
        model,
        label: 'deepseek',
        secret: { source: 'file', envKey: `AGIM_LLM_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` },
      })
      backends.push({
        name: flashName,
        provider: 'openai-compat',
        baseUrl,
        model: 'deepseek-v4-flash',
        label: 'deepseek',
        secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_DEEPSEEK_V4_FLASH' },
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
    if (u === '/api/llm/backends/deepseek-v4-pro/ping' && method === 'POST') {
      return jsonResponse(opts.pingResponse ?? {
        name: 'deepseek-v4-pro',
        ok: true,
        durationMs: 123,
        tokensIn: 3,
        tokensOut: 2,
        sampleText: 'pong',
      })
    }
    if (u.startsWith('/api/llm/backends?') && method === 'DELETE') {
      const qs = new URL(u, 'http://local').searchParams
      const label = (qs.get('label') || '').trim().toLowerCase()
      const names = (qs.get('names') || '').split(',').map((s) => s.trim()).filter(Boolean)
      const toRemove = new Set<string>()
      if (label) {
        for (const b of backends) {
          if ((b.label ?? '').trim().toLowerCase() === label) toRemove.add(b.name)
        }
      } else {
        for (const n of names) toRemove.add(n)
      }
      let removedRoles = 0
      for (let i = backends.length - 1; i >= 0; i -= 1) {
        const row = backends[i]
        if (!row || !toRemove.has(row.name)) continue
        backends.splice(i, 1)
      }
      for (const [role, bound] of Object.entries(roles)) {
        if (toRemove.has(bound)) {
          delete roles[role]
          removedRoles += 1
        }
      }
      return jsonResponse({ removed: [...toRemove], removedRoles })
    }
    const del = u.match(/^\/api\/llm\/backends\/([^/?]+)$/)
    if (del && method === 'DELETE') {
      const name = decodeURIComponent(del[1] ?? '')
      const idx = backends.findIndex((b) => b.name === name)
      let removedRoles = 0
      if (idx >= 0) {
        backends.splice(idx, 1)
        for (const [role, bound] of Object.entries(roles)) {
          if (bound === name) {
            delete roles[role]
            removedRoles += 1
          }
        }
      }
      return jsonResponse({ removedRoles })
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
    expect(screen.getByText('Currently using deepseek-v4-pro. Open Web chat to test it.')).toBeInTheDocument()

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
        (c) => String(c[0]) === '/api/llm/backends/deepseek-v4-pro/ping'
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

  it('embedded (chat/Portal) advanced toggle skips admin-only runtime env panel', async () => {
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
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <SettingsLlmPanel embedded />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /show advanced settings/i }))
    expect(await screen.findByText('APIs (1)')).toBeInTheDocument()
    expect(screen.queryByText('Agim Agent runtime settings')).not.toBeInTheDocument()
  })

  it('groups sibling DeepSeek backends under one provider cluster', async () => {
    mockLlmFetch({
      backends: [
        {
          name: 'deepseek-v4-pro',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-pro',
          label: 'deepseek',
          secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_DEEPSEEK_V4_PRO' },
        },
        {
          name: 'deepseek-v4-flash',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          label: 'deepseek',
          secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_DEEPSEEK_V4_FLASH' },
        },
      ],
      roles: { 'native-chat': 'deepseek-v4-pro' },
      config: { defaultAgent: 'agim' },
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /show advanced settings/i }))
    expect(await screen.findByText('APIs (2)')).toBeInTheDocument()
    expect(screen.getByText(/Grouped by provider \(1 groups\)/i)).toBeInTheDocument()
    expect(screen.getByText('2 models')).toBeInTheDocument()
    expect(screen.getAllByText('DeepSeek').length).toBeGreaterThanOrEqual(1)
    // Delete lives on the group, not on each model row.
    expect(screen.getByRole('button', { name: /Remove provider "DeepSeek"/i })).toBeInTheDocument()
    // Groups start collapsed — models stay hidden until expand.
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    const groupToggle = screen.getByRole('button', { expanded: false })
    fireEvent.click(groupToggle)
    expect(groupToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('table')).toBeInTheDocument()
    // Name column matches model id (model + name cells; other UI may also cite the id).
    expect(screen.getAllByText('deepseek-v4-pro').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('deepseek-v4-flash').length).toBeGreaterThanOrEqual(2)
    // Row actions keep Ping only — no per-model Remove.
    expect(screen.getAllByRole('button', { name: /^Ping$/i })).toHaveLength(2)
    expect(screen.queryAllByRole('button', { name: /^Remove$/i })).toHaveLength(0)
  })

  it('marks installed built-in presets as already added in the Add API dropdown', async () => {
    // jsdom lacks scrollIntoView; Radix Select calls it when opening.
    Element.prototype.scrollIntoView = vi.fn()
    mockLlmFetch({
      backends: [
        {
          name: 'mimo-v2.5-pro',
          provider: 'openai-compat',
          baseUrl: 'https://api.xiaomimimo.com/v1',
          model: 'mimo-v2.5-pro',
          label: 'mimo',
          secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_MIMO' },
        },
        {
          name: 'mimo-v2.5',
          provider: 'openai-compat',
          baseUrl: 'https://api.xiaomimimo.com/v1',
          model: 'mimo-v2.5',
          label: 'mimo',
          secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_MIMO_2' },
        },
      ],
      roles: { 'native-chat': 'mimo-v2.5-pro' },
      config: { defaultAgent: 'agim' },
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /show advanced settings/i }))
    expect(await screen.findByRole('heading', { name: 'Add API' })).toBeInTheDocument()
    const form = screen.getByRole('heading', { name: 'Add API' }).closest('section')
    expect(form).toBeTruthy()
    const presetTrigger = requireValue(
      form?.querySelector('[role="combobox"]') as HTMLElement | null,
      'preset combobox',
    )
    fireEvent.click(presetTrigger)
    const options = await screen.findAllByRole('option')
    const byLabel = Object.fromEntries(options.map((o) => [o.textContent?.trim() ?? '', o]))
    const mimoOpt = requireValue(byLabel['MiMo (already added)'], 'MiMo already-added option')
    expect(
      mimoOpt.getAttribute('aria-disabled') === 'true'
      || mimoOpt.hasAttribute('data-disabled'),
    ).toBe(true)
    expect(byLabel.DeepSeek?.getAttribute('aria-disabled')).not.toBe('true')
    expect(byLabel.Custom?.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('removes an entire provider group from the group-level delete control', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fetchSpy = mockLlmFetch({
      backends: [
        {
          name: 'deepseek-v4-pro',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-pro',
          label: 'deepseek',
          secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_DEEPSEEK_V4_PRO' },
        },
        {
          name: 'deepseek-v4-flash',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          label: 'deepseek',
          secret: { source: 'file', envKey: 'AGIM_LLM_SECRET_DEEPSEEK_V4_FLASH' },
        },
      ],
      roles: { 'native-chat': 'deepseek-v4-pro', cheap: 'deepseek-v4-flash' },
      config: { defaultAgent: 'agim' },
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /show advanced settings/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Remove provider "DeepSeek"/i }))
    expect(confirmSpy).toHaveBeenCalled()
    await waitFor(() => {
      const deletes = fetchSpy.mock.calls.filter(
        (c) => String(c[0]).startsWith('/api/llm/backends') && (c[1] as RequestInit | undefined)?.method === 'DELETE',
      )
      expect(deletes).toHaveLength(1)
      expect(String(deletes[0]?.[0])).toBe('/api/llm/backends?label=deepseek')
    })
  })

  it('exposes a collapsed Advanced parameters section for Custom presets', async () => {
    mockLlmFetch()
    renderPage()

    await waitFor(() => expect(screen.getByText('Quick-enable Agim Agent')).toBeInTheDocument())
    // Quick-enable form also has a preset select — open advanced via Add API after enabling is heavy.
    // Exercise Add API path with an empty backend list by expanding advanced settings.
    fireEvent.click(screen.getByRole('button', { name: /show advanced settings/i }))
    expect(await screen.findByRole('heading', { name: 'Add API' })).toBeInTheDocument()
    const form = requireValue(
      screen.getByRole('heading', { name: 'Add API' }).closest('section'),
      'Add API section',
    )
    Element.prototype.scrollIntoView = vi.fn()
    fireEvent.click(requireValue(
      form.querySelector('[role="combobox"]') as HTMLElement | null,
      'preset combobox',
    ))
    fireEvent.click(await screen.findByRole('option', { name: /^Custom$/i }))
    expect(await screen.findByRole('button', { name: /Advanced parameters/i })).toBeInTheDocument()
    expect(screen.queryByText('Compat template')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Advanced parameters/i }))
    expect(await screen.findByText('Compat template')).toBeInTheDocument()
    expect(screen.getByText('Thinking format')).toBeInTheDocument()
    expect(screen.getByText('Context window')).toBeInTheDocument()
    expect(screen.getByText('Extra HTTP headers')).toBeInTheDocument()
  })

  it('opens a details dialog when the quick probe fails', async () => {
    mockLlmFetch({
      pingResponse: {
        name: 'deepseek-v4-pro',
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
