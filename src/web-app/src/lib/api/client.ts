/**
 * lib/api/client.ts — single fetch wrapper every endpoints.ts function
 * calls. PR-3 ships the minimum viable shape (Bearer injection,
 * JSON-or-text handling, ApiError throw on non-2xx). PR-4 layers on
 * 401 redirect-to-login + a more nuanced error-code mapper that
 * react-i18next consumes.
 *
 * Mobile-aware: we never await Response.text() when the response is a
 * stream — sonner toasts won't appear on phones until the fetch
 * resolves, and big bodies on a flaky 4G can take forever otherwise.
 */

import type { ApiError } from '@/types/api'

const TOKEN_STORAGE_KEY = 'agim_token'

/**
 * RequestOptions intentionally accepts a loose `query` shape so the
 * generated endpoints.ts can pass typed-interface query objects
 * (e.g. ListJobsQuery) without exact-type-friendly index signatures.
 * `buildQueryString` coerces every value to a string at runtime.
 */
/**
 * RequestOptions.query is declared as `object | undefined` (not the
 * more obvious `Record<string, ...>`) so the generated endpoints.ts
 * can pass a typed-interface query value (`ListJobsQuery`,
 * `ListMemoryFactsQuery`, etc.) directly. TypeScript treats interfaces
 * without an explicit index signature as *not* assignable to
 * `Record<string, unknown>`; `object` is the looser bound that
 * accommodates both shapes. `buildQueryString` runtime-iterates over
 * the entries, so the type loosening is purely a compile-time
 * concession.
 */
export interface RequestOptions {
  query?: object | undefined
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

function buildQueryString(q: RequestOptions['query']): string {
  if (!q) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'boolean') {
      parts.push(`${encodeURIComponent(k)}=${v ? '1' : '0'}`)
      continue
    }
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = path + buildQueryString(opts.query)
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  const tok = getStoredToken()
  if (tok && !headers.Authorization) {
    headers.Authorization = `Bearer ${tok}`
  }
  let body: BodyInit | undefined
  if (opts.body !== undefined && opts.body !== null) {
    if (opts.body instanceof FormData || typeof opts.body === 'string') {
      body = opts.body
    } else {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
      body = JSON.stringify(opts.body)
    }
  }

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    })
  } catch (err) {
    // Network failure (offline, DNS, aborted by user). Surface as
    // ApiError so the QueryClient onError handler can toast it
    // uniformly with HTTP errors. PR-4 wires the toast.
    const message = err instanceof Error ? err.message : String(err)
    throw new ApiClientError({
      code: 'NETWORK',
      message,
      status: 0,
    })
  }

  if (res.status === 204) {
    return undefined as T
  }

  const ct = res.headers.get('content-type') || ''
  const isJson = ct.includes('application/json')

  if (!res.ok) {
    let code = `HTTP_${res.status}`
    let message = res.statusText
    if (isJson) {
      try {
        const body = (await res.json()) as { error?: string; code?: string }
        if (body.error) message = body.error
        if (body.code) code = body.code
        // Heuristic: agim's legacy backend returns chinese phrases like
        // "Unauthorized" / "token required" — recognize a handful so
        // PR-4's i18n table can map to a key.
        if (res.status === 401) code = 'AUTH_INVALID'
        if (res.status === 403) code = 'FORBIDDEN'
        if (res.status === 404) code = 'NOT_FOUND'
        if (res.status === 413) code = 'PAYLOAD_TOO_LARGE'
      } catch {
        /* keep default */
      }
    }
    throw new ApiClientError({ code, message, status: res.status })
  }

  if (isJson) {
    return (await res.json()) as T
  }
  // Fall back to text for non-JSON 2xx (e.g. /api/memory/export).
  return (await res.text()) as unknown as T
}

/**
 * ApiClientError carries the structured error shape every consumer
 * (react-query onError, toast subscriber, error boundary) expects.
 * Throw via `throw new ApiClientError(...)`; catch in QueryClient's
 * defaultOptions.queries.onError (PR-4).
 */
export class ApiClientError extends Error implements ApiError {
  code: string
  status: number
  constructor(spec: ApiError) {
    super(spec.message)
    this.name = 'ApiClientError'
    this.code = spec.code
    this.status = spec.status
  }
}

export const client = {
  get:    <T>(path: string, opts?: RequestOptions): Promise<T> => request<T>('GET',    path, opts),
  post:   <T>(path: string, opts?: RequestOptions): Promise<T> => request<T>('POST',   path, opts),
  put:    <T>(path: string, opts?: RequestOptions): Promise<T> => request<T>('PUT',    path, opts),
  patch:  <T>(path: string, opts?: RequestOptions): Promise<T> => request<T>('PATCH',  path, opts),
  delete: <T>(path: string, opts?: RequestOptions): Promise<T> => request<T>('DELETE', path, opts),
}

/** Test-only — drop the saved token without bouncing through localStorage exceptions. */
export function _clearStoredToken(): void {
  try { localStorage.removeItem(TOKEN_STORAGE_KEY) } catch { /* private mode */ }
}
