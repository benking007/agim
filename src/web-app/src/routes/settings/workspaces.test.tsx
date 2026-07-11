import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { requireValue } from '@/test/assert'

import SettingsWorkspacesRoute from './workspaces'
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

function renderPage(opts: {
  workspaces?: Array<Record<string, unknown>>
  agents?: Record<string, boolean>
  knownUsers?: Array<Record<string, unknown>>
} = {}): ReturnType<typeof render> & { fetchSpy: ReturnType<typeof vi.spyOn> } {
  const workspaces = opts.workspaces ?? [
    {
      id: 'default',
      name: 'Default',
      agents: [],
      members: [],
      rateLimit: { rate: 10, intervalSec: 60, burst: 15 },
    },
  ]
  const agents = opts.agents ?? { 'claude-code': true, codex: false }
  const knownUsers = opts.knownUsers ?? [
    {
      platform: 'wechat',
      userId: 'u1',
      firstSeenAt: '2026-07-01T01:00:00Z',
      lastSeenAt: '2026-07-01T02:00:00Z',
    },
  ]

  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input)
    if (u === '/api/workspaces?full=1') {
      return jsonResponse({ workspaces })
    }
    if (u === '/api/agents/status') return jsonResponse(agents)
    if (u === '/api/admin-allowlist') {
      return jsonResponse({ admins: [], knownUsers, configured: false })
    }
    if (u === '/api/workspaces' && init?.method === 'POST') {
      return jsonResponse({ ok: true, workspace: JSON.parse(String(init.body)) })
    }
    if (u.startsWith('/api/workspaces/') && init?.method === 'DELETE') {
      return jsonResponse({ ok: true })
    }
    return jsonResponse({})
  })

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/settings/workspaces']}>
        <Routes>
          <Route path="/settings/workspaces" element={<SettingsWorkspacesRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return Object.assign(view, { fetchSpy })
}

describe('/settings/workspaces', () => {
  it('presents workspace registry as access scopes', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Access Scopes' })).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('Only the default scope')).toBeInTheDocument())
    expect(screen.getByText('Add or edit access scope')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save scope/i })).toBeInTheDocument()
  })

  it('selects agents and members from discovered candidates before saving', async () => {
    const user = userEvent.setup()
    const { fetchSpy } = renderPage()

    await waitFor(() => expect(screen.getByRole('button', { name: /Choose Agents/i })).toBeInTheDocument())

    await user.type(screen.getByLabelText('ID'), 'team-a')
    await user.type(screen.getByLabelText('Display name'), 'Team A')
    // Stabilize focus before Radix moves it into the portalled menu.
    await user.click(document.body)

    await user.click(screen.getByRole('button', { name: /Choose Agents/i }))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /claude-code/i }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Choose members/i }))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /wechat:u1/i }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Save scope/i }))

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) => String(c[0]) === '/api/workspaces' && (c[1] as RequestInit | undefined)?.method === 'POST')
      expect(call).toBeTruthy()
      const request = requireValue(call?.[1] as RequestInit | undefined, 'workspace create request')
      const body = JSON.parse(String(request.body))
      expect(body).toMatchObject({
        id: 'team-a',
        name: 'Team A',
        agents: ['claude-code'],
        members: ['wechat:u1'],
      })
    })
  })

  it('applies a rate-limit preset before saving', async () => {
    const user = userEvent.setup()
    const { fetchSpy } = renderPage()

    await waitFor(() => expect(screen.getByRole('button', { name: /Strict/i })).toBeInTheDocument())

    await user.type(screen.getByLabelText('ID'), 'team-a')
    await user.type(screen.getByLabelText('Display name'), 'Team A')
    await user.click(screen.getByRole('button', { name: /Strict/i }))
    await user.click(screen.getByRole('button', { name: /Save scope/i }))

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) => String(c[0]) === '/api/workspaces' && (c[1] as RequestInit | undefined)?.method === 'POST')
      expect(call).toBeTruthy()
      const request = requireValue(call?.[1] as RequestInit | undefined, 'workspace update request')
      const body = JSON.parse(String(request.body))
      expect(body.rateLimit).toEqual({ rate: 3, intervalSec: 60, burst: 5 })
    })
  })

  it('deletes a non-default access scope after confirmation', async () => {
    const user = userEvent.setup()
    const { fetchSpy } = renderPage({
      workspaces: [
        {
          id: 'default',
          name: 'Default',
          agents: [],
          members: [],
          rateLimit: { rate: 10, intervalSec: 60, burst: 15 },
        },
        {
          id: 'team-a',
          name: 'Team A',
          agents: ['claude-code'],
          members: ['wechat:u1'],
          rateLimit: { rate: 3, intervalSec: 60, burst: 5 },
        },
      ],
    })

    await waitFor(() => expect(screen.getByText('Team A')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /Delete team-a/i }))
    await user.click(await screen.findByRole('button', { name: /Delete scope/i }))

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) => String(c[0]) === '/api/workspaces/team-a' && (c[1] as RequestInit | undefined)?.method === 'DELETE')
      expect(call).toBeTruthy()
    })
  })
})
