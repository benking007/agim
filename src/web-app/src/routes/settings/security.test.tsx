import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

import SettingsSecurityRoute from './security'
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

const BASE_DIAGNOSTICS = {
  runningAsRoot: false,
  envFile: { exists: true, mode: '600', tooPermissive: false },
  bwrapAvailable: false,
  senderAllowlistConfigured: false,
  adminAllowlistConfigured: false,
  platformBlacklist: [],
  liveEnv: {},
}

function renderPage(opts: {
  env?: Record<string, string>
  diagnostics?: typeof BASE_DIAGNOSTICS
  knownUsers?: Array<Record<string, unknown>>
} = {}): ReturnType<typeof render> & { fetchSpy: ReturnType<typeof vi.spyOn> } {
  const env = opts.env ?? {
    AGIM_ALLOWED_USERS: '',
    AGIM_DANGEROUSLY_SKIP_PERMISSIONS: '1',
    AGIM_NATIVE_FS_RESTRICT: '0',
  }
  const diagnostics = opts.diagnostics ?? BASE_DIAGNOSTICS
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
    if (u === '/api/env?reveal=0') return jsonResponse({ env })
    if (u === '/api/security/diagnostics') return jsonResponse({ diagnostics })
    if (u === '/api/admin-allowlist') {
      return jsonResponse({ admins: [], knownUsers, configured: false })
    }
    if (u === '/api/env' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      return jsonResponse({ env: { ...env, ...body.updates } })
    }
    return jsonResponse({})
  })

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/security']}>
        <Routes>
          <Route path="/settings/security" element={<SettingsSecurityRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
  return Object.assign(view, { fetchSpy })
}

describe('/settings/security', () => {
  it('summarizes security posture before advanced controls', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Security posture' })).toBeInTheDocument())
    expect(screen.getByText('Agent permission confirmations are skipped')).toBeInTheDocument()
    expect(screen.getByText('IM sender access is open')).toBeInTheDocument()
    expect(screen.getByText('No IM admin configured')).toBeInTheDocument()
    expect(screen.getByText('Native filesystem is not confined to the workspace')).toBeInTheDocument()
  })

  it('selects discovered IM users for the sender allowlist', async () => {
    const user = userEvent.setup()
    const { fetchSpy } = renderPage({
      env: {
        AGIM_ALLOWED_USERS: '',
        AGIM_DANGEROUSLY_SKIP_PERMISSIONS: '0',
        AGIM_NATIVE_FS_RESTRICT: '1',
      },
      diagnostics: {
        ...BASE_DIAGNOSTICS,
        adminAllowlistConfigured: true,
      },
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restrict to list' })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Restrict to list' }))
    await user.click(screen.getByRole('button', { name: 'Choose users' }))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /wechat:u1/i }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Save gate' }))

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) => String(c[0]) === '/api/env' && (c[1] as RequestInit | undefined)?.method === 'PUT')
      expect(call).toBeTruthy()
      const body = JSON.parse(String((call![1] as RequestInit).body))
      expect(body).toEqual({ updates: { AGIM_ALLOWED_USERS: 'wechat:u1' } })
    })
  })
})
