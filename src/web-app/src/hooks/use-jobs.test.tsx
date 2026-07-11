/**
 * useJobs — verify the react-query plumbing for the jobs domain:
 *   * useJobs() calls api.listJobs with the right query
 *   * useInvalidateJobs() invalidates every ['jobs', ...] cache entry
 *   * useBatchCancelJobs() invalidates on success
 *   * useBatchCancelJobs() does NOT auto-invalidate on failure
 *
 * The fetch wrapper (lib/api/client.ts) goes through window.fetch —
 * we stub that, not the api object itself, so we exercise the
 * complete glue chain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { requireValue } from '@/test/assert'
import {
  useJobs,
  useInvalidateJobs,
  useBatchCancelJobs,
  jobsKeys,
} from './use-jobs'

function makeWrapper(qc: QueryClient): React.FC<{ children: React.ReactNode }> {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

let qc: QueryClient

beforeEach(() => {
  localStorage.setItem('agim_token', 'tok')
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('useJobs', () => {
  it('fetches /api/jobs with the query params', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ jobs: [{ id: 1, agent: 'x', prompt: 'p', status: 'running', kind: 'job', created_at: 'now' }] }),
    )
    const { result } = renderHook(() => useJobs({ limit: 20, offset: 0, status: 'running' }), {
      wrapper: makeWrapper(qc),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.jobs).toHaveLength(1)
    const url = String(requireValue(fetchSpy.mock.calls[0]?.[0], 'jobs request URL')).split('?')
    expect(url[0]).toBe('/api/jobs')
    expect(url[1]).toContain('status=running')
    expect(url[1]).toContain('limit=20')
  })

  it('caches under the keyed query so two hooks share one fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jobs: [] }),
    )
    const wrapper = makeWrapper(qc)
    const a = renderHook(() => useJobs({ limit: 10, offset: 0 }), { wrapper })
    const b = renderHook(() => useJobs({ limit: 10, offset: 0 }), { wrapper })
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('useInvalidateJobs', () => {
  it('marks every jobs query stale', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jobs: [] }))
    const wrapper = makeWrapper(qc)
    const list = renderHook(() => useJobs({ limit: 10, offset: 0 }), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(qc.getQueryState(jobsKeys.list({ limit: 10, offset: 0 }))?.isInvalidated).toBeFalsy()

    const invalidate = renderHook(() => useInvalidateJobs(), { wrapper })
    act(() => {
      invalidate.result.current()
    })
    expect(qc.getQueryState(jobsKeys.list({ limit: 10, offset: 0 }))?.isInvalidated).toBe(true)
  })
})

describe('useBatchCancelJobs', () => {
  it('invalidates jobs on success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(jsonResponse({ jobs: [] }))       // useJobs initial
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }))       // mutation
    fetchSpy.mockResolvedValueOnce(jsonResponse({ jobs: [] }))       // invalidation refetch
    const wrapper = makeWrapper(qc)
    const list = renderHook(() => useJobs({ limit: 10, offset: 0 }), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    const { result } = renderHook(() => useBatchCancelJobs(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ ids: [1, 2] })
    })
    // The mutation hits POST /api/jobs/batch-cancel
    const reqs = fetchSpy.mock.calls.map((c) => c[0])
    expect(reqs).toContain('/api/jobs/batch-cancel')
  })

  it('does not invalidate on failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }))                 // initial list
      .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, { status: 500 })) // mutation fail
    const wrapper = makeWrapper(qc)
    const list = renderHook(() => useJobs({ limit: 10, offset: 0 }), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    const { result } = renderHook(() => useBatchCancelJobs(), { wrapper })
    await expect(
      result.current.mutateAsync({ ids: [1] }),
    ).rejects.toMatchObject({ status: 500 })
    // The list query stays not-invalidated.
    expect(qc.getQueryState(jobsKeys.list({ limit: 10, offset: 0 }))?.isInvalidated).toBeFalsy()
  })
})
