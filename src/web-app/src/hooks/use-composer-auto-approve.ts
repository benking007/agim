/**
 * Composer chip state for main-agent AGIM_AUTO_APPROVE.
 * Any authenticated peer (incl. Portal QR) can read/write via
 * /api/policy/auto-approve — not the admin-only /api/env surface.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type { AutoApprovePolicyResponse } from '@/types/api'
import { settingsKeys } from '@/hooks/use-settings'

export const autoApprovePolicyKey = ['policy', 'auto-approve'] as const

export function useComposerAutoApprove() {
  const qc = useQueryClient()
  const query = useQuery<AutoApprovePolicyResponse>({
    queryKey: autoApprovePolicyKey,
    queryFn: () => api.getAutoApprovePolicy(),
    staleTime: 15_000,
  })
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => api.updateAutoApprovePolicy({ enabled }),
    onSuccess: (data) => {
      qc.setQueryData(autoApprovePolicyKey, data)
      // Keep Settings → Policy card in sync when open.
      void qc.invalidateQueries({ queryKey: ['settings', 'env'] })
      void qc.invalidateQueries({ queryKey: settingsKeys.env(false) })
    },
  })
  return {
    enabled: !!query.data?.enabled,
    effective: !!query.data?.effective,
    loading: query.isLoading,
    error: query.error,
    setting: mutation.isPending,
    setEnabled: (enabled: boolean) => mutation.mutateAsync(enabled),
  }
}
