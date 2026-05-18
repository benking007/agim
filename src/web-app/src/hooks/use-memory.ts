/**
 * useMemory — react-query wrappers for the agent long-term memory.
 *
 *   useMemoryUsers()                — pick list of users that have
 *                                     facts in the bank
 *   useMemoryFacts(query)           — pageable facts for one user
 *   useDeleteFactById()             — single-row delete
 *   useBulkDeleteFacts()            — multi / category / threshold
 *
 * No SSE channel; memory mutations are operator-driven and the
 * react-query 30s staleTime is enough. Mutations invalidate the
 * full ['memory'] tree so adjacent views (e.g. the user summary's
 * fact_count) stay in sync.
 */

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import { ApiClientError } from '@/lib/api/client'
import type {
  ConsolidateMemoryResponse,
  ConsolidateStatusResponse,
  DeleteMemoryFactsBody,
  DeleteMemoryFactsResponse,
  ListMemoryFactsQuery,
  ListMemoryFactsResponse,
  ListMemoryUsersResponse,
  OkResponse,
  Persona,
  UpdatePersonaBody,
} from '@/types/api'

export const memoryKeys = {
  all:           ['memory'] as const,
  users:         ['memory', 'users'] as const,
  facts:         (q: ListMemoryFactsQuery) => ['memory', 'facts', q] as const,
  persona:       (user_key: string) => ['memory', 'persona', user_key] as const,
  consolidate:   ['memory', 'consolidate'] as const,
}

export function useMemoryUsers() {
  return useQuery<ListMemoryUsersResponse>({
    queryKey: memoryKeys.users,
    queryFn: () => api.listMemoryUsers(),
  })
}

export function useMemoryFacts(query: ListMemoryFactsQuery, opts: { enabled?: boolean } = {}) {
  return useQuery<ListMemoryFactsResponse>({
    queryKey: memoryKeys.facts(query),
    queryFn: () => api.listMemoryFacts(query),
    // Caller passes enabled=false until a user_key is chosen so the
    // hook doesn't fire with an empty key.
    enabled: opts.enabled !== false && Boolean(query.user_key),
  })
}

export function useInvalidateMemory() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: memoryKeys.all })
}

export function useDeleteFactById() {
  const qc = useQueryClient()
  return useMutation<
    OkResponse & { id: number },
    Error,
    { id: number; user_key: string }
  >({
    mutationFn: ({ id, user_key }) => api.deleteMemoryFactById(id, { user_key }),
    onSuccess: () => qc.invalidateQueries({ queryKey: memoryKeys.all }),
  })
}

export function useBulkDeleteFacts() {
  const qc = useQueryClient()
  return useMutation<
    DeleteMemoryFactsResponse,
    Error,
    { user_key: string; body: DeleteMemoryFactsBody }
  >({
    mutationFn: ({ user_key, body }) => api.deleteMemoryFacts({ user_key }, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: memoryKeys.all }),
  })
}

/* ─────────────── Persona ─────────────── */

/** Fetch the persona for a user. The backend returns 404 when the
 *  user has no persona yet — we map that to `data: null` so the
 *  route can render the "not set yet" state without a try/catch. */
export function useMemoryPersona(user_key: string, opts: { enabled?: boolean } = {}) {
  return useQuery<Persona | null>({
    queryKey: memoryKeys.persona(user_key),
    queryFn: async () => {
      try {
        return await api.getMemoryPersona({ user_key })
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 404) return null
        throw err
      }
    },
    enabled: opts.enabled !== false && Boolean(user_key),
  })
}

export function useUpdatePersona() {
  const qc = useQueryClient()
  return useMutation<
    { ok: boolean },
    Error,
    { user_key: string; body: UpdatePersonaBody }
  >({
    mutationFn: ({ user_key, body }) => api.updateMemoryPersona({ user_key }, body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: memoryKeys.persona(vars.user_key) })
      qc.invalidateQueries({ queryKey: memoryKeys.users })
    },
  })
}

export function useDeletePersona() {
  const qc = useQueryClient()
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (user_key) => api.deleteMemoryPersona({ user_key }),
    onSuccess: (_data, user_key) => {
      qc.invalidateQueries({ queryKey: memoryKeys.persona(user_key) })
      qc.invalidateQueries({ queryKey: memoryKeys.users })
    },
  })
}

/* ─────────────── Consolidate ─────────────── */

/** Status of the in-flight + recent consolidation jobs. Polls while
 *  the page is open since consolidate runs asynchronously and we
 *  want the operator to see when it completes without manual
 *  refresh. */
export function useConsolidateStatus(opts: { enabled?: boolean } = {}) {
  return useQuery<ConsolidateStatusResponse>({
    queryKey: memoryKeys.consolidate,
    queryFn: () => api.getMemoryConsolidateStatus(),
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    enabled: opts.enabled !== false,
  })
}

export function useTriggerConsolidate() {
  const qc = useQueryClient()
  return useMutation<ConsolidateMemoryResponse, Error, void>({
    mutationFn: () => api.consolidateMemory(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: memoryKeys.consolidate })
      qc.invalidateQueries({ queryKey: memoryKeys.all })
    },
  })
}
