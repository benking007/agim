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
import type {
  DeleteMemoryFactsBody,
  DeleteMemoryFactsResponse,
  ListMemoryFactsQuery,
  ListMemoryFactsResponse,
  ListMemoryUsersResponse,
  OkResponse,
} from '@/types/api'

export const memoryKeys = {
  all:    ['memory'] as const,
  users:  ['memory', 'users'] as const,
  facts:  (q: ListMemoryFactsQuery) => ['memory', 'facts', q] as const,
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
