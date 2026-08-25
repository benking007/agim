import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api/endpoints'
import { useAuth } from '@/stores/auth'
import type { MePointsResponse } from '@/types/api'

export const mePointsKey = ['me', 'points'] as const

export function isPortalAccountId(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && /^usr_[A-Za-z0-9_-]+$/.test(userId.trim())
}

export function useComposerPoints() {
  const userId = useAuth((s) => s.user?.id ?? null)
  const enabled = isPortalAccountId(userId)
  const query = useQuery<MePointsResponse>({
    queryKey: mePointsKey,
    queryFn: () => api.getMePoints(),
    enabled,
    staleTime: 15_000,
  })
  return {
    enabled,
    balance: query.data?.balance ?? null,
    ledger: query.data?.ledger ?? [],
    daily: query.data?.daily ?? [],
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  }
}
