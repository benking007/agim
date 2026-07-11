import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

import SettingsPolicyRoute from './policy'
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

function renderPage(env: Record<string, string> = {
  AGIM_AUTO_APPROVE: '1',
  AGIM_TIMEOUT_DEFAULT: 'deny',
  AGIM_APPROVAL_TIMEOUT_MS: '120000',
}): ReturnType<typeof render> & { fetchSpy: ReturnType<typeof vi.spyOn> } {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input)
    const method = init?.method
    if (method === 'PUT' && u === '/api/env') {
      const body = JSON.parse(String(init.body)) as { updates: Record<string, string | null> }
      Object.assign(env, body.updates)
      return jsonResponse({ env })
    }
    if (/^\/api\/env(\?|$)/.test(u)) return jsonResponse({ env, secretKeys: [] })
    return jsonResponse({})
  })

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/settings/policy']}>
        <Routes>
          <Route path="/settings/policy" element={<SettingsPolicyRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
  return Object.assign(view, { fetchSpy })
}

describe('/settings/policy', () => {
  it('shows auto-approve as enabled when AGIM_AUTO_APPROVE is unset', async () => {
    renderPage({
      AGIM_TIMEOUT_DEFAULT: 'allow',
      AGIM_APPROVAL_TIMEOUT_MS: '120000',
    })

    const title = await screen.findByText(/^(Auto-Approve|自动审批)$/i)
    const section = title.closest('section')
    if (!section) throw new Error('Auto-Approve section not found')
    expect(within(section).getByText('ON')).toBeInTheDocument()
    expect(within(section).getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('surfaces auto-approve and saves approval timeout seconds as milliseconds', async () => {
    const user = userEvent.setup()
    const { fetchSpy } = renderPage()

    await waitFor(() => {
      expect(screen.getByText(/^(Auto-Approve|自动审批)$/i)).toBeInTheDocument()
    })
    expect(screen.getByText('AGIM_AUTO_APPROVE')).toBeInTheDocument()
    expect(screen.getByText('AGIM_APPROVAL_TIMEOUT_MS')).toBeInTheDocument()

    const input = screen.getByRole('spinbutton', { name: /approval wait time|审批等待时长/i })
    expect(input).toHaveValue(120)

    await user.clear(input)
    await user.type(input, '45')
    await user.click(screen.getByRole('button', { name: /save time|保存时长/i }))

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) => {
        const init = c[1] as RequestInit | undefined
        if (String(c[0]) !== '/api/env' || init?.method !== 'PUT') return false
        const body = JSON.parse(String(init.body))
        return body.updates?.AGIM_APPROVAL_TIMEOUT_MS === '45000'
      })
      expect(call).toBeTruthy()
    })
  })
})
