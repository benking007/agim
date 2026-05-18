/**
 * useOutbox — react-query wrappers for the delivery queue.
 *
 *   useOutbox(query)          — list rows (status / thread / limit)
 *   useOutboxStats()          — small summary for KPI cards
 *   useRetryOutbox()          — retry a giving_up row by id
 *
 * The outbox isn't on the SSE bus. Routes use the react-query
 * polling fallback (5s) plus the existing SSE `job` event, which
 * effectively covers any newly-enqueued row (a job that runs to
 * completion enqueues one or more outbox rows).
 */

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type { ListOutboxQuery, ListOutboxResponse, OutboxStats } from '@/types/api'

export const outboxKeys = {
  all:   ['outbox'] as const,
  list:  (q: ListOutboxQuery) => ['outbox', 'list', q] as const,
  stats: ['outbox', 'stats'] as const,
}

export function useOutbox(query: ListOutboxQuery) {
  return useQuery<ListOutboxResponse>({
    queryKey: outboxKeys.list(query),
    queryFn: () => api.listOutbox(query),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
}

export function useOutboxStats() {
  return useQuery<OutboxStats>({
    queryKey: outboxKeys.stats,
    queryFn: () => api.getOutboxStats(),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  })
}

export function useInvalidateOutbox() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: outboxKeys.all })
}

export function useRetryOutbox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.retryOutbox(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: outboxKeys.all }),
  })
}
