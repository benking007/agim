/**
 * useJobs — react-query wrappers for the jobs domain.
 *
 *   useJobs(query)            — list with filter / pagination
 *   useBatchCancelJobs()      — bulk cancel mutation
 *   useBatchRunJobs()         — bulk re-run mutation
 *
 * Query keys: `['jobs', 'list', stableQuery]` so SSE invalidation
 * via useEventStream({ job: () => qc.invalidateQueries(['jobs']) })
 * clears every list view at once. The serialised query object is
 * stable across renders (react-query handles deep equality), so
 * keying on it directly is safe.
 *
 * Why hooks not raw `useQuery`: every route hits the same listJobs
 * endpoint with similar shapes; centralising the key + error toast
 * (caller-supplied) here keeps the route files focused on layout.
 */

import { useQueryClient, useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type { BatchJobBody, ListJobsQuery, ListJobsResponse } from '@/types/api'

export const jobsKeys = {
  all:  ['jobs'] as const,
  list: (q: ListJobsQuery) => ['jobs', 'list', q] as const,
}

export function useJobs(query: ListJobsQuery) {
  return useQuery<ListJobsResponse>({
    queryKey: jobsKeys.list(query),
    queryFn: () => api.listJobs(query),
  })
}

/** Force-refresh every jobs list view. Call this from the SSE
 *  `job` handler in route files. */
export function useInvalidateJobs() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: jobsKeys.all })
}

export function useBatchCancelJobs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: BatchJobBody) => api.batchCancelJobs(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: jobsKeys.all }),
  })
}

export function useBatchRunJobs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: BatchJobBody) => api.batchRunJobs(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: jobsKeys.all }),
  })
}
