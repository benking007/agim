/**
 * useA2A* — react-query wrappers for the Agent-to-Agent inline-job
 * view. Read-only; data lives in jobs.db and is exposed via:
 *
 *   GET /api/a2a/stats   → totals, recent24h, maxDepth, byStatus/byAgent
 *   GET /api/a2a/recent  → recent rows (truncated prompt + result)
 *
 * SSE: subscribes to the `job` event so a freshly-completed inline
 * sub-invocation shows up without manual refresh.
 */

import { useQueryClient, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type { A2AStats, ListA2ARecentQuery, ListA2ARecentResponse } from '@/types/api'

export const a2aKeys = {
  all:    ['a2a'] as const,
  stats:  ['a2a', 'stats'] as const,
  recent: (q: ListA2ARecentQuery) => ['a2a', 'recent', q] as const,
}

export function useA2AStats() {
  return useQuery<A2AStats>({
    queryKey: a2aKeys.stats,
    queryFn: () => api.getA2AStats(),
  })
}

export function useA2ARecent(query: ListA2ARecentQuery) {
  return useQuery<ListA2ARecentResponse>({
    queryKey: a2aKeys.recent(query),
    queryFn: () => api.getA2ARecent(query),
  })
}

export function useInvalidateA2A() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: a2aKeys.all })
}
