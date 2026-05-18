/**
 * useApprovals — react-query wrappers for the HITL approval queue.
 *
 *   useApprovals()       — list pending + bus metrics
 *   useResolveApproval() — allow / deny a specific reqId
 *
 * SSE: the route subscribes to the `approval` SSE event and
 * invalidates this query on any phase change, so a `requested` from
 * another tab (or `resolved` we don't initiate) shows up live
 * without a poll.
 *
 * No background poll — approvals are short-lived, the SSE channel
 * is the live source, and the v1 admin's 3 s poll caused enough
 * jitter that we'd rather rely on SSE plus an explicit refresh
 * button.
 */

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type { ListApprovalsResponse, ResolveApprovalBody, ResolveApprovalResponse } from '@/types/api'

export const approvalsKeys = {
  all:  ['approvals'] as const,
  list: ['approvals', 'list'] as const,
}

export function useApprovals() {
  return useQuery<ListApprovalsResponse>({
    queryKey: approvalsKeys.list,
    queryFn: () => api.listApprovals(),
  })
}

export function useInvalidateApprovals() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: approvalsKeys.all })
}

export function useResolveApproval() {
  const qc = useQueryClient()
  return useMutation<
    ResolveApprovalResponse,
    Error,
    { reqId: string; body: ResolveApprovalBody }
  >({
    mutationFn: ({ reqId, body }) => api.resolveApproval(reqId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: approvalsKeys.all }),
  })
}
