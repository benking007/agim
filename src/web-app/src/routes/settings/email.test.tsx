/**
 * /settings/email smoke — R13. The route ships SMTP config + a
 * verify-only Test connection button (R5). Coverage:
 *   * Empty env → 'disabled' badge, no Save bar (not dirty)
 *   * Configured env → 'configured' badge
 *   * Test connection fires POST /api/messengers/email/test, success
 *     toast on { ok: true, message }
 *   * Test connection failure surfaces the error detail
 *   * Editing a field opens the Save bar
 *   * Disable SMTP clears all six env keys
 *   * TLS mode normalisation (env "1"/"yes" → "true"; "0"/"no" → "false";
 *     anything else → "auto")
 *   * Masked PASS in the input is NOT shipped on Save (no clobber)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import SettingsEmailRoute, { normalizeSecure } from './email'
import '@/i18n'

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
      <MemoryRouter initialEntries={['/settings/email']}>
        <Routes>
          <Route path="/settings/email" element={<SettingsEmailRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const EMPTY_ENV = { env: {}, secretKeys: ['AGIM_SMTP_PASS'] }

const CONFIGURED_ENV = {
  env: {
    AGIM_SMTP_HOST: 'smtp.gmail.com',
    AGIM_SMTP_PORT: '465',
    AGIM_SMTP_USER: 'me@example.com',
    AGIM_SMTP_PASS: 'abcd****wxyz', // masked
    AGIM_SMTP_FROM: 'me@example.com',
    AGIM_SMTP_SECURE: 'true',
  },
  secretKeys: ['AGIM_SMTP_PASS'],
}

/** Match any /api/env GET (`?reveal=0` / `?reveal=1` / bare). */
function isEnvGet(u: string, method: string | undefined): boolean {
  return method !== 'PUT' && /^\/api\/env(\?|$)/.test(u)
}
function isEnvPut(u: string, method: string | undefined): boolean {
  return method === 'PUT' && /^\/api\/env(\?|$)/.test(u)
}

describe('/settings/email', () => {
  it('empty env → disabled badge, no Save bar', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (isEnvGet(String(input), 'GET')) return jsonResponse(EMPTY_ENV)
      return jsonResponse({})
    })
    renderPage()
    // The empty-env form has a placeholder we can wait on.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('smtp.gmail.com')).toBeInTheDocument()
    })
    expect(screen.getByText(/disabled/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument()
  })

  it('configured env → configured badge + values pre-filled', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(CONFIGURED_ENV))
    renderPage()
    await waitFor(() => expect(screen.getByDisplayValue('smtp.gmail.com')).toBeInTheDocument())
    expect(screen.getByText(/configured/i)).toBeInTheDocument()
    expect(screen.getByDisplayValue('465')).toBeInTheDocument()
    // user + from default to the same email — getAll is correct here.
    expect(screen.getAllByDisplayValue('me@example.com').length).toBe(2)
  })

  it('Test connection → success toast on ok:true', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = String(input)
      if (isEnvGet(u, init?.method)) return jsonResponse(CONFIGURED_ENV)
      if (u === '/api/messengers/email/test' && init?.method === 'POST') {
        return jsonResponse({ ok: true, message: 'Connected to smtp.gmail.com:465' })
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByDisplayValue('smtp.gmail.com')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    await waitFor(() => {
      expect(screen.getByText(/Connected to smtp\.gmail\.com:465/)).toBeInTheDocument()
    })
  })

  it('Test connection → toast describes error on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = String(input)
      if (isEnvGet(u, init?.method)) return jsonResponse(CONFIGURED_ENV)
      if (u === '/api/messengers/email/test' && init?.method === 'POST') {
        return jsonResponse(
          {
            ok: false,
            error: 'Greeting never received',
            code: 'EMAIL_VERIFY_FAILED',
            detail: 'Greeting never received',
          },
          400,
        )
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByDisplayValue('smtp.gmail.com')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    await waitFor(() => {
      expect(screen.getByText(/Greeting never received/)).toBeInTheDocument()
    })
  })

  it('editing a field opens the Save bar', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(CONFIGURED_ENV))
    renderPage()
    const hostInput = await screen.findByDisplayValue('smtp.gmail.com')
    fireEvent.change(hostInput, { target: { value: 'mail.example.com' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument()
    })
  })

  it('Disable SMTP clears all six env keys', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = String(input)
      if (isEnvGet(u, init?.method)) return jsonResponse(CONFIGURED_ENV)
      if (isEnvPut(u, init?.method)) return jsonResponse(EMPTY_ENV)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByDisplayValue('smtp.gmail.com')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /disable smtp/i }))
    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) => isEnvPut(String(c[0]), (c[1] as RequestInit | undefined)?.method),
      )
      expect(putCall).toBeDefined()
      const body = JSON.parse(String((putCall![1] as RequestInit).body)) as {
        updates: Record<string, string | null>
      }
      for (const key of [
        'AGIM_SMTP_HOST', 'AGIM_SMTP_PORT', 'AGIM_SMTP_USER',
        'AGIM_SMTP_PASS', 'AGIM_SMTP_FROM', 'AGIM_SMTP_SECURE',
      ]) {
        expect(body.updates[key]).toBeNull()
      }
    })
  })

  describe('normalizeSecure (TLS mode mapping)', () => {
    // Radix Select trigger label doesn't reliably render in jsdom, so
    // we test the pure mapping function directly instead of clicking
    // through the form.
    it.each([
      ['1',     'true'],
      ['true',  'true'],
      ['TRUE',  'true'],   // case-insensitive
      ['yes',   'true'],
      ['  1  ', 'true'],   // trims
      ['0',     'false'],
      ['false', 'false'],
      ['no',    'false'],
      ['',      'auto'],
      [undefined, 'auto'],
      ['banana','auto'],
      ['2',     'auto'],   // numeric ≠ 1/0 falls through
    ] as const)('env %j → %s', (raw, want) => {
      expect(normalizeSecure(raw)).toBe(want)
    })
  })

  it('masked PASS is not echoed back on Save (no clobber)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = String(input)
      if (isEnvGet(u, init?.method)) return jsonResponse(CONFIGURED_ENV)
      if (isEnvPut(u, init?.method)) return jsonResponse(CONFIGURED_ENV)
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByDisplayValue('smtp.gmail.com')).toBeInTheDocument())
    // Change host so isDirty fires.
    fireEvent.change(screen.getByDisplayValue('smtp.gmail.com'), {
      target: { value: 'mail.example.com' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))
    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) => isEnvPut(String(c[0]), (c[1] as RequestInit | undefined)?.method),
      )
      expect(putCall).toBeDefined()
      const body = JSON.parse(String((putCall![1] as RequestInit).body)) as {
        updates: Record<string, string | null>
      }
      // Host change sent.
      expect(body.updates.AGIM_SMTP_HOST).toBe('mail.example.com')
      // PASS (still the mask `abcd****wxyz`) NOT shipped.
      expect('AGIM_SMTP_PASS' in body.updates).toBe(false)
    })
  })
})
