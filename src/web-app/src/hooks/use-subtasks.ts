/**
 * useSubtasks — react-query wrapper for /api/subtasks.
 *
 * Subtasks are a flattened view of session.subtasks across every
 * conversation file in ~/.agim/sessions/. The endpoint is read-only
 * — no cancel / re-run mutation surface (yet). Live refresh rides on
 * the same SSE 'job' event (subtask state changes piggy-back on the
 * parent job's lifecycle).
 */

import { useQueryClient, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type { ListSubtasksQuery, ListSubtasksResponse } from '@/types/api'

export const subtasksKeys = {
  all:  ['subtasks'] as const,
  list: (q: ListSubtasksQuery) => ['subtasks', 'list', q] as const,
}

export function useSubtasks(query: ListSubtasksQuery) {
  return useQuery<ListSubtasksResponse>({
    queryKey: subtasksKeys.list(query),
    queryFn: () => api.listSubtasks(query),
  })
}

export function useInvalidateSubtasks() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: subtasksKeys.all })
}
