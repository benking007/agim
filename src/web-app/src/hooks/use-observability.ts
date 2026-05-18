/**
 * useObservability — react-query wrappers for the operational
 * dashboard.
 *
 *   useHealthSummary({ days })         — totals + byDay roll-up
 *   useTopN({ dim, by, days, limit })  — leaderboard by dimension
 *   useAudit(query)                    — recent invocations
 *
 * All three are read-only; observability stays a passive view.
 * Refetch intervals are tuned to match operator expectations:
 * health summary every 30s (background sweep latency); audit
 * every 10s (fresher); TopN every 60s (the leaderboard moves
 * slowly enough).
 */

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type {
  AuditResponse,
  HealthSummary,
  ListAuditQuery,
  TopNDim,
  TopNMetric,
  TopNResponse,
} from '@/types/api'

export const observabilityKeys = {
  all:     ['observability'] as const,
  health:  (days: number) => ['observability', 'health', days] as const,
  topN:    (dim: TopNDim, by: TopNMetric, days: number, limit: number) =>
    ['observability', 'topn', dim, by, days, limit] as const,
  audit:   (q: ListAuditQuery) => ['observability', 'audit', q] as const,
}

export function useHealthSummary(days: number) {
  return useQuery<HealthSummary>({
    queryKey: observabilityKeys.health(days),
    queryFn: () => api.getHealthSummary({ days }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
}

export function useTopN(opts: { dim: TopNDim; by: TopNMetric; days?: number; limit?: number }) {
  const days = opts.days ?? 7
  const limit = opts.limit ?? 10
  return useQuery<TopNResponse>({
    queryKey: observabilityKeys.topN(opts.dim, opts.by, days, limit),
    queryFn: () => api.getHealthTopN({ dim: opts.dim, by: opts.by, days, limit }),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })
}

export function useAudit(query: ListAuditQuery) {
  return useQuery<AuditResponse>({
    queryKey: observabilityKeys.audit(query),
    queryFn: () => api.getAudit(query),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
}
