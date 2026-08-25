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
  source: 'workspace' | 'builtin' | 'user'
  always: boolean
  available: boolean
  unavailableReason?: string
  requiresBins: string[]
  requiresEnv: string[]
  dir: string
  enabled?: boolean
  /** v1.2.152 — system-prompt injection bucket (0–4). See loader.ts
   *  `rankSkillBucket`. SPA uses this to group + collapse the installed
   *  list. Optional for backward compat with older agim builds. */
  bucket?: 0 | 1 | 2 | 3 | 4
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
    queryFn: () => {
      if (!name) throw new Error('Skill name is required')
      return client.get<AgimSkillDetailResponse>(`/api/agim-skills/${encodeURIComponent(name)}`)
    },
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

export function useAgimSkillSetEnabled() {
  const qc = useQueryClient()
  return useMutation<
    { name: string; enabled: boolean; rebuilding: boolean },
    Error,
    { name: string; enabled: boolean }
  >({
    mutationFn: ({ name, enabled }) =>
      client.patch(`/api/agim-skills/${encodeURIComponent(name)}/enabled`, { body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

// ─── v1.2.151 — injection-block override editor (operator-facing) ──────

export interface AgimSkillsInjectionResponse {
  /** The auto-generated tier-1 skill block from the live loader state.
   *  Read-only preview the SPA shows on the left. */
  auto: string
  autoChars: number
  /** Current override file content (null when no override is active). */
  override: string | null
  overrideChars: number
  /** Absolute filesystem path of the override file (display-only). */
  overridePath: string
  /** True when the loader is currently using the override instead of
   *  the auto block. */
  overrideActive: boolean
  /** Server-enforced character cap on the override body. */
  maxOverrideChars: number
}

const injectionKey = ['agim-skills', 'injection'] as const

export function useSkillInjection() {
  return useQuery<AgimSkillsInjectionResponse>({
    queryKey: injectionKey,
    queryFn: () => client.get<AgimSkillsInjectionResponse>('/api/agim-skills/injection'),
  })
}

export function useSkillInjectionSave() {
  const qc = useQueryClient()
  return useMutation<{ saved: boolean; deleted?: boolean; length?: number }, Error, string>({
    mutationFn: (body) => client.put('/api/agim-skills/injection', { body: { body } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: injectionKey }),
  })
}

export function useSkillInjectionDelete() {
  const qc = useQueryClient()
  return useMutation<{ deleted: boolean }, Error, void>({
    mutationFn: () => client.delete('/api/agim-skills/injection'),
    onSuccess: () => qc.invalidateQueries({ queryKey: injectionKey }),
  })
}
