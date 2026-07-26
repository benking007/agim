/**
 * useSkills — read-only browse of the agent skills.
 *
 *   useSkills()              — list of every skill on disk
 *   useSkillDetail(slug)     — markdown body, fetched on demand
 *                              when the modal opens
 *
 * No mutations: installs happen via the skillhub CLI on the host,
 * agim is strictly read-only here.
 */

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type {
  ListSkillsResponse,
  SkillDetail,
} from '@/types/api'

export const skillsKeys = {
  all:        ['skills'] as const,
  list:       ['skills', 'list'] as const,
  detail:     (slug: string) => ['skills', 'detail', slug] as const,
}

export function useSkills() {
  return useQuery<ListSkillsResponse>({
    queryKey: skillsKeys.list,
    queryFn: () => api.listSkills(),
  })
}

export function useSkillDetail(slug: string | null) {
  return useQuery<SkillDetail>({
    queryKey: skillsKeys.detail(slug ?? ''),
    queryFn: () => api.getSkillDetail(slug as string),
    enabled: Boolean(slug),
  })
}

