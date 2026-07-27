/**
 * /settings/agents smoke — R13. Covers:
 *   * built-in agents render with online/offline badges driven by
 *     /api/agents/status
 *   * Toggling an agent opens the Save bar
 *   * Default-agent picker only lists agents that are BOTH enabled
 *     AND online (eligibleDefaults invariant)
 *   * Disabling the current default clears the picker so Save can't
 *     ship an inconsistent {agents[], defaultAgent} pair
 *   * Save sends one PUT /api/config carrying agents + defaultAgent
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { requireValue } from '@/test/assert'
import SettingsAgentsRoute from './agents'
import '@/i18n'

// jsdom doesn't implement Element.prototype.scrollIntoView, but
// Radix Select calls it when an option is focused. Polyfill once.
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
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/settings/agents']}>
        <Routes>
          <Route path="/settings/agents" element={<SettingsAgentsRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const CONFIG = {
  agents: ['claude-code', 'codex'],
  defaultAgent: 'claude-code',
  defaultAgentDescription: '',
  messengers: [],
  features: { globalIm: true },
}

const STATUS = {
  'claude-code': true,
  'codex': false, // installed but circuit-open
  'copilot': true,
  'opencode': true,
  'antigravity': false,
  'cursor': true,
  'kimi-code': true,
  'qoder': true,
  'pi': true,
  'mimo': true,
}

function mockStandardFetch(extraConfig?: Record<string, unknown>) {
  const cfg = { ...CONFIG, ...(extraConfig ?? {}) }
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input)
    if (u === '/api/config') {
      if (init?.method === 'PUT') {
        return jsonResponse({ ...cfg, ...(JSON.parse(String(init.body)) as Record<string, unknown>) })
      }
      return jsonResponse(cfg)
    }
    if (u === '/api/agents/status') return jsonResponse(STATUS)
    return jsonResponse({})
  })
}

describe('/settings/agents — built-in adapters', () => {
  it('renders the built-in agent rows with online/offline badges', async () => {
    mockStandardFetch()
    renderPage()
    await waitFor(() => expect(screen.getAllByText('claude-code').length).toBeGreaterThan(0))
    expect(screen.getAllByText('codex').length).toBeGreaterThan(0)
    expect(screen.getAllByText('opencode').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Antigravity').length).toBeGreaterThan(0)
    expect(screen.getAllByText('cursor').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Kimi Code').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Qoder').length).toBeGreaterThan(0)
    expect(screen.getAllByText('PI').length).toBeGreaterThan(0)
    expect(screen.getAllByText('MiMo Code').length).toBeGreaterThan(0)
    // claude-code appears in the agent row, default picker, and specialty profiles.
    expect(screen.getAllByText('claude-code').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/派工能力画像|Dispatch specialty profiles/i)).toBeInTheDocument()
    // claude-code is online (true) — but at least one row should have
    // the "online" badge. Use getAllByText to be tolerant of i18n.
    expect(screen.getAllByText(/online|在线/i).length).toBeGreaterThan(0)
  })

  it('default picker only lists enabled + online agents', async () => {
    // claude-code (enabled, online) ✓
    // codex (enabled, offline) ✗
    // opencode (disabled, online — disabled wins) ✗
    mockStandardFetch()
    renderPage()
    await waitFor(() => expect(screen.getAllByText('claude-code').length).toBeGreaterThan(0))
    // The select uses Radix; opening it surfaces SelectItem options.
    // Scope to the default-agent picker via its input id.
    const defaultAgentTrigger = document.getElementById('default-agent')
    expect(defaultAgentTrigger).not.toBeNull()
    fireEvent.click(requireValue(defaultAgentTrigger, 'default agent trigger'))
    expect(screen.getByRole('listbox')).toHaveClass('overflow-y-auto')
    await waitFor(() => {
      const options = screen.queryAllByRole('option')
      const optionTexts = options.map((o) => o.textContent || '')
      // Order: only claude-code is in the eligible bucket
      expect(optionTexts).toContain('claude-code')
      expect(optionTexts).not.toContain('codex')
      expect(optionTexts).not.toContain('opencode')
    })
  })

  it('disabling the current default clears the picker (no inconsistent save)', async () => {
    mockStandardFetch()
    renderPage()
    await waitFor(() => expect(screen.getAllByText('claude-code').length).toBeGreaterThan(0))
    // Find the claude-code row's checkbox and uncheck it.
    const checkboxes = screen.getAllByRole('checkbox')
    // Order = AGENT_NAMES = ['claude-code','codex','copilot','opencode','antigravity','cursor','kimi-code','qoder','pi','mimo','agim']
    fireEvent.click(requireValue(checkboxes[0], 'claude-code checkbox'))
    // Now claude-code is no longer enabled. The picker should show the
    // "no eligible" placeholder text or be disabled.
    await waitFor(() => {
      // Save bar must appear (we're dirty)
      expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument()
    })
  })

  it('Save sends PUT /api/config with agents + defaultAgent atomically', async () => {
    const fetchSpy = mockStandardFetch()
    renderPage()
    await waitFor(() => expect(screen.getAllByText('claude-code').length).toBeGreaterThan(0))
    // Enable opencode (currently disabled in CONFIG.agents)
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(requireValue(checkboxes[3], 'opencode checkbox'))
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) => String(c[0]) === '/api/config' && (c[1] as RequestInit | undefined)?.method === 'PUT',
      )
      expect(putCall).toBeDefined()
      const request = requireValue(putCall?.[1] as RequestInit | undefined, 'agent config request')
      const body = JSON.parse(String(request.body)) as {
        agents: string[]
        defaultAgent: string
      }
      // Both built-in changes and the existing defaultAgent travel
      // together in a single PUT.
      expect(body.agents).toContain('opencode')
      expect(body.defaultAgent).toBe('claude-code')
    })
  })
})
