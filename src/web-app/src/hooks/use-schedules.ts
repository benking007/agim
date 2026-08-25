/**
 * useSchedules — react-query wrapper for /api/schedules.
 */

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type {
  CreateScheduleBody,
  CreateScheduleResponse,
  ListSchedulesQuery,
  ListSchedulesResponse,
  UpdateScheduleBody,
  UpdateScheduleResponse,
} from '@/types/api'

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

export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation<CreateScheduleResponse, Error, CreateScheduleBody>({
    mutationFn: (body) => api.createSchedule(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulesKeys.all }),
  })
}

export function useUpdateSchedule() {
  const qc = useQueryClient()
  return useMutation<UpdateScheduleResponse, Error, { id: number; body: UpdateScheduleBody }>({
    mutationFn: ({ id, body }) => api.updateSchedule(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulesKeys.all }),
  })
}

export function useDeleteSchedule() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, number>({
    mutationFn: (id) => api.deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulesKeys.all }),
  })
}
