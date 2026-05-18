/**
 * useSchedules — react-query wrapper for /api/schedules.
 *
 * Read-only: schedule create / delete / toggle isn't exposed via
 * /api today (only via CLI). When that lands the mutations slot in
 * here next to useSchedules.
 */

import { useQueryClient, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type { ListSchedulesQuery, ListSchedulesResponse } from '@/types/api'

export const schedulesKeys = {
  all:  ['schedules'] as const,
  list: (q: ListSchedulesQuery) => ['schedules', 'list', q] as const,
}

export function useSchedules(query: ListSchedulesQuery) {
  return useQuery<ListSchedulesResponse>({
    queryKey: schedulesKeys.list(query),
    queryFn: () => api.listSchedules(query),
  })
}

export function useInvalidateSchedules() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: schedulesKeys.all })
}
