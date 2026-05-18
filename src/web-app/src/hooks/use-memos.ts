/**
 * useMemos — react-query wrappers for memos search + delete.
 *
 *   useMemos(query)       — search/list
 *   useDeleteMemo()       — DELETE /api/memos/:id
 *
 * No SSE channel for memos (they're operator-created from chat, not
 * from autonomous agent activity), and no background poll: the page
 * shows search results which are inherently user-triggered.
 * Mutation onSuccess invalidates so a delete removes the row
 * immediately without a manual refresh.
 */

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type {
  DeleteMemoResponse,
  ListMemosQuery,
  ListMemosResponse,
} from '@/types/api'

export const memosKeys = {
  all:  ['memos'] as const,
  list: (q: ListMemosQuery) => ['memos', 'list', q] as const,
}

export function useMemos(query: ListMemosQuery) {
  return useQuery<ListMemosResponse>({
    queryKey: memosKeys.list(query),
    queryFn: () => api.listMemos(query),
  })
}

export function useInvalidateMemos() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: memosKeys.all })
}

export function useDeleteMemo() {
  const qc = useQueryClient()
  return useMutation<DeleteMemoResponse, Error, number>({
    mutationFn: (id) => api.deleteMemo(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: memosKeys.all }),
  })
}
