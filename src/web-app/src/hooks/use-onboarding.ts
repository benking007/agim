import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type { OnboardingStatus } from '@/types/api'
import { settingsKeys } from '@/hooks/use-settings'

export const onboardingKeys = {
  status: ['onboarding', 'status'] as const,
}

export function useOnboardingStatus() {
  return useQuery<OnboardingStatus>({
    queryKey: onboardingKeys.status,
    queryFn: () => api.getOnboardingStatus(),
    staleTime: 5_000,
  })
}

export function useSkipOnboarding() {
  const qc = useQueryClient()
  return useMutation<OnboardingStatus, Error, void>({
    mutationFn: () => api.skipOnboarding(),
    onSuccess: (data) => {
      qc.setQueryData(onboardingKeys.status, data)
      void qc.invalidateQueries({ queryKey: settingsKeys.config })
    },
  })
}
