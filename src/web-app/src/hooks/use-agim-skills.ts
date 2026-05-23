/**
 * use-agim-skills — react-query wrappers for the agim SKILL.md
 * editor (`/api/agim-skills/*`).
 *
 * Distinct from the pre-existing `useSkills*` hooks against
 * `/api/skills` (which lists per-agent workspace CLI skills);
 * this set targets the in-process loader from
 * src/core/skills/loader.ts.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '@/lib/api/client'

export interface AgimSkillMeta {
  name: string
  description: string
  source: 'workspace' | 'builtin'
  always: boolean
  available: boolean
  unavailableReason?: string
  requiresBins: string[]
  requiresEnv: string[]
  dir: string
}

export interface AgimSkillsListResponse {
  skills: AgimSkillMeta[]
  count: number
  maxBodyChars: number
}

export interface AgimSkillDetailResponse {
  meta: AgimSkillMeta
  body: string
}

const skillKeys = {
  all:  ['agim-skills'] as const,
  list: ['agim-skills', 'list'] as const,
  one:  (name: string) => ['agim-skills', 'one', name] as const,
}

export function useAgimSkillsList() {
  return useQuery<AgimSkillsListResponse>({
    queryKey: skillKeys.list,
    queryFn: () => client.get<AgimSkillsListResponse>('/api/agim-skills'),
  })
}

export function useAgimSkill(name: string | null) {
  return useQuery<AgimSkillDetailResponse>({
    queryKey: name ? skillKeys.one(name) : ['agim-skills', 'one', '__none__'],
    queryFn: () => client.get<AgimSkillDetailResponse>(`/api/agim-skills/${encodeURIComponent(name!)}`),
    enabled: !!name,
  })
}

export function useAgimSkillCreate() {
  const qc = useQueryClient()
  return useMutation<{ meta: AgimSkillMeta }, Error, { name: string; body: string }>({
    mutationFn: (body) => client.post('/api/agim-skills', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

export function useAgimSkillUpdate() {
  const qc = useQueryClient()
  return useMutation<{ meta: AgimSkillMeta }, Error, { name: string; body: string }>({
    mutationFn: ({ name, body }) => client.put(
      `/api/agim-skills/${encodeURIComponent(name)}`, { body: { body } },
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

export function useAgimSkillDelete() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, string>({
    mutationFn: (name) => client.delete(`/api/agim-skills/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

export function useAgimSkillsRefresh() {
  const qc = useQueryClient()
  return useMutation<{ count: number }, Error, void>({
    mutationFn: () => client.post('/api/agim-skills/refresh'),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}
