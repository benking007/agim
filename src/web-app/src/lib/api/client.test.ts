/**
 * lib/api/client.test.ts — verify the fetch wrapper's key contracts:
 *   * Bearer injection from localStorage
 *   * 2xx JSON → typed Promise
 *   * Non-2xx → ApiClientError with stable `code` + `status`
 *   * 401 → token cleared + `location.href` set to /login?next=
 *   * Network failure → ApiClientError code='NETWORK'
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, client, _clearStoredToken } from './client'

const TOKEN_KEY = 'agim_token'

// jsdom doesn't allow assigning a string to location.href (that
// would actually navigate). Spy on `assign` and the underlying
// pathname / search by replacing the whole `location` object via
// vi.stubGlobal — restored cleanly in afterEach.
function mockLocation(pathname = '/tasks', search = ''): { setHref: ReturnType<typeof vi.fn> } {
  const setHref = vi.fn()
  let _href = `http://localhost:3000${pathname}${search}`
  const fake = {
    pathname,
    search,
    get href(): string { return _href },
    set href(v: string) { _href = v; setHref(v) },
  }
  vi.stubGlobal('location', fake as unknown as Location)
  return { setHref }
}

afterEach(() => {
  _clearStoredToken()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('client', () => {
  beforeEach(() => {
    localStorage.setItem(TOKEN_KEY, 'agim_test_token')
  })

  it('injects Authorization: Bearer from localStorage', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await client.get<{ ok: boolean }>('/api/health')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer agim_test_token')
  })

  it('parses JSON body on 2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ count: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const r = await client.get<{ count: number }>('/api/foo')
    expect(r).toEqual({ count: 42 })
  })

  it('throws ApiClientError on non-2xx with mapped code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(client.get('/api/foo')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      message: 'forbidden',
    })
  })

  it('honors explicit backend code over HTTP-status fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'CUSTOM_X', error: 'detail' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(client.get('/api/foo')).rejects.toMatchObject({
      code: 'CUSTOM_X',
      status: 400,
    })
  })

  it('on 401 → clears token + redirects to /login?next=', async () => {
    const loc = mockLocation('http://localhost:3000/tasks?x=1')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'no auth' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(client.get('/api/jobs')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      status: 401,
    })
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(loc.setHref).toHaveBeenCalledTimes(1)
    expect(loc.setHref.mock.calls[0]?.[0]).toMatch(/\/login\?next=/)
  })

  it('on AUTH_ADMIN_REQUIRED 403 → clears token + redirects with reason=admin', async () => {
    const loc = mockLocation('/settings/llm', '?pane=api')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'AUTH_ADMIN_REQUIRED', error: 'admin role required' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(client.get('/api/agim-skills')).rejects.toMatchObject({
      code: 'AUTH_ADMIN_REQUIRED',
      status: 403,
    })
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(loc.setHref).toHaveBeenCalledTimes(1)
    expect(loc.setHref.mock.calls[0]?.[0]).toMatch(/\/login\?next=.*&reason=admin$/)
  })

  it('on legacy 403 "admin role required" → redirects to login', async () => {
    const loc = mockLocation('/settings/service')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'admin role required' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(client.post('/api/service/restart')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    })
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(loc.setHref).toHaveBeenCalledTimes(1)
    expect(loc.setHref.mock.calls[0]?.[0]).toMatch(/\/login\?next=.*&reason=admin$/)
  })

  it('does NOT redirect when /api/auth/* itself returns 401', async () => {
    const loc = mockLocation('http://localhost:3000/login')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'bad token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(
      client.post('/api/auth/login', { body: { token: 'x' } }),
    ).rejects.toMatchObject({ status: 401 })
    expect(loc.setHref).not.toHaveBeenCalled()
  })

  it('wraps network failures as ApiClientError with code=NETWORK', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(client.get('/api/foo')).rejects.toBeInstanceOf(ApiClientError)
    await expect(client.get('/api/foo')).rejects.toMatchObject({
      code: 'NETWORK',
      status: 0,
    })
  })
})
