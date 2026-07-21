/**
 * useBgjobs — react-query wrappers for /api/bgjobs.
 *
 * Primary write root is the shared ~/.agim/bgjobs tree (all agents).
 * Legacy Claude / opencode / Codex roots remain readable. No SSE for
 * bgjob events — list polls every 5s while focused; detail polls faster
 * while the selected job is still running.
 */

import { useQueryClient, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type {
  GetBgjobResponse,
  ListBgjobsQuery,
  ListBgjobsResponse,
} from '@/types/api'

export const bgjobsKeys = {
  all: ['bgjobs'] as const,
  list: (q: ListBgjobsQuery) => ['bgjobs', 'list', q] as const,
  detail: (id: string | null, root: string | null) =>
    ['bgjobs', 'detail', id, root] as const,
}

export function useBgjobs(query: ListBgjobsQuery, opts?: { enabled?: boolean }) {
  return useQuery<ListBgjobsResponse>({
    queryKey: bgjobsKeys.list(query),
    queryFn: () => api.listBgJobs(query),
    enabled: opts?.enabled !== false,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
}

export function useBgjobDetail(id: string | null, rootId: string | null) {
  return useQuery<GetBgjobResponse>({
    queryKey: bgjobsKeys.detail(id, rootId),
    queryFn: () => {
      if (!id) throw new Error('bgjob id required')
      return api.getBgJob(id, {
        ...(rootId ? { root: rootId } : {}),
        tail: 200,
      })
    },
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const status = q.state.data?.job.status?.toLowerCase()
      return status === 'running' || status === 'paused' || status === 'starting'
        ? 3000
        : false
    },
    refetchIntervalInBackground: false,
  })
}

export function useInvalidateBgjobs() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: bgjobsKeys.all })
}
