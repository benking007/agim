/**
 * useReminders — react-query wrappers for the reminders domain.
 *
 *   useReminders(query)        — list pending (default) or by status
 *   useCancelReminder()        — POST /api/reminders/:id/cancel
 *   useSnoozeReminder()        — POST /api/reminders/:id/snooze
 *
 * Reminders aren't on the SSE event-bus today; the page combines a
 * 5s react-query poll with a manual Refresh button. When a snooze
 * mutation lands, both the original AND the new reminder change
 * (one cancelled, one pending) — invalidating the full 'reminders'
 * key catches both.
 */

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type {
  CancelReminderResponse,
  ListRemindersQuery,
  ListRemindersResponse,
  SnoozeReminderBody,
  SnoozeReminderResponse,
} from '@/types/api'

export const remindersKeys = {
  all:  ['reminders'] as const,
  list: (q: ListRemindersQuery) => ['reminders', 'list', q] as const,
}

export function useReminders(query: ListRemindersQuery) {
  return useQuery<ListRemindersResponse>({
    queryKey: remindersKeys.list(query),
    queryFn: () => api.listReminders(query),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
}

export function useInvalidateReminders() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: remindersKeys.all })
}

export function useCancelReminder() {
  const qc = useQueryClient()
  return useMutation<CancelReminderResponse, Error, number>({
    mutationFn: (id) => api.cancelReminder(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: remindersKeys.all }),
  })
}

export function useSnoozeReminder() {
  const qc = useQueryClient()
  return useMutation<
    SnoozeReminderResponse,
    Error,
    { id: number; body: SnoozeReminderBody }
  >({
    mutationFn: ({ id, body }) => api.snoozeReminder(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: remindersKeys.all }),
  })
}
