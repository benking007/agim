/**
 * useBgjobs — react-query wrapper for /api/bgjobs.
 *
 * Bgjobs are a read-only window into the wrapper-managed bgjob
 * directories (Claude Code's ~/.claude/bgjobs/, opencode's
 * ~/.config/opencode/bgjobs/, codex's ~/.codex/bgjobs/, plus any
 * AGIM_BGJOB_ROOTS custom paths). No SSE channel for bgjob events;
 * the page polls or refresh-on-demand.
 *
 * Response shape varies based on whether `root` is set — when no
 * root filter is applied the backend returns groups keyed by rootId.
 * The hook leaves that shape intact; flattening logic lives in the
 * route's `useMemo` so a future "show per-root" view can pivot
 * cheaply.
 */

import { useQueryClient, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type { ListBgjobsQuery, ListBgjobsResponse } from '@/types/api'

export const bgjobsKeys = {
  all:  ['bgjobs'] as const,
  list: (q: ListBgjobsQuery) => ['bgjobs', 'list', q] as const,
}

export function useBgjobs(query: ListBgjobsQuery) {
  return useQuery<ListBgjobsResponse>({
    queryKey: bgjobsKeys.list(query),
    queryFn: () => api.listBgJobs(query),
    // Bgjobs file scans are cheap (FS reads) but we don't want to
    // hammer when the user idles on the tab. Auto-refetch every 5s
    // while the tab is focused matches the v1 admin's behavior.
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
}

export function useInvalidateBgjobs() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: bgjobsKeys.all })
}
