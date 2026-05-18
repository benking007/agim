/**
 * useVector — react-query wrappers for the embedding/vector backend.
 *
 *   useVectorStatus({ user_key })       — status + coverage + jobs
 *                                          (polls every 3s; jobs
 *                                          are async)
 *   useTriggerVectorBackfill()
 *   useTriggerVectorDownload()
 *   useTriggerVectorClear()             — DESTRUCTIVE; route gates
 *                                          with ConfirmDialog
 *   useTriggerVectorTest()
 *
 * Status polling stops backgrounded (refetchIntervalInBackground:
 * false) so an idle tab on a phone doesn't drain battery.
 */

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import { memoryKeys } from './use-memory'
import type {
  VectorActionResponse,
  VectorClearResponse,
  VectorStatus,
  VectorTestResponse,
} from '@/types/api'

export const vectorKeys = {
  all:    ['memory', 'vector'] as const,
  status: (user_key?: string) => ['memory', 'vector', 'status', user_key ?? null] as const,
}

export function useVectorStatus(query: { user_key?: string } = {}) {
  return useQuery<VectorStatus>({
    queryKey: vectorKeys.status(query.user_key),
    queryFn: () => api.getMemoryVectorStatus(query),
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  })
}

function invalidateAfter(qc: ReturnType<typeof useQueryClient>): () => void {
  return () => {
    qc.invalidateQueries({ queryKey: vectorKeys.all })
    qc.invalidateQueries({ queryKey: memoryKeys.all })
  }
}

export function useTriggerVectorBackfill() {
  const qc = useQueryClient()
  const invalidate = invalidateAfter(qc)
  return useMutation<
    VectorActionResponse,
    Error,
    { user_key?: string; max_rows?: number } | undefined
  >({
    mutationFn: (vars) => api.backfillMemoryVector(
      { user_key: vars?.user_key },
      vars?.max_rows ? { max_rows: vars.max_rows } : undefined,
    ),
    onSuccess: invalidate,
  })
}

export function useTriggerVectorDownload() {
  const qc = useQueryClient()
  return useMutation<VectorActionResponse, Error, void>({
    mutationFn: () => api.downloadMemoryVector(),
    onSuccess: invalidateAfter(qc),
  })
}

export function useTriggerVectorClear() {
  const qc = useQueryClient()
  return useMutation<VectorClearResponse, Error, { user_key?: string } | undefined>({
    mutationFn: (vars) => api.clearMemoryVector({ user_key: vars?.user_key }),
    onSuccess: invalidateAfter(qc),
  })
}

export function useTriggerVectorTest() {
  return useMutation<VectorTestResponse, Error, void>({
    mutationFn: () => api.testMemoryVector(),
  })
}
