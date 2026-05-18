/**
 * useSettings — react-query wrappers for the env editor + service
 * control surfaces.
 *
 *   useEnv({ reveal })             — env file values (masked when
 *                                    reveal is false)
 *   useUpdateEnv()                 — bulk update
 *   useServiceStatus()             — pid / mode / uptime
 *   useStart/Stop/Restart()        — service lifecycle
 *
 * Service status polls every 5s while the page is foreground so
 * the operator sees restart progress live.
 */

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type {
  AddAdminBody,
  AdminAllowlistResponse,
  AdminMutationResponse,
  AppConfig,
  EnvResponse,
  RemoveAdminBody,
  ServiceActionResponse,
  ServiceStatus,
  UpdateEnvBody,
  WorkspaceConfig,
} from '@/types/api'

export const settingsKeys = {
  all:        ['settings'] as const,
  env:        (reveal: boolean) => ['settings', 'env', reveal] as const,
  service:    ['settings', 'service'] as const,
  admins:     ['settings', 'admins'] as const,
  config:     ['settings', 'config'] as const,
  workspaces: ['settings', 'workspaces'] as const,
}

export function useEnv(opts: { reveal?: boolean } = {}) {
  const reveal = !!opts.reveal
  return useQuery<EnvResponse>({
    queryKey: settingsKeys.env(reveal),
    queryFn: () => api.getEnv({ reveal }),
  })
}

export function useUpdateEnv() {
  const qc = useQueryClient()
  return useMutation<EnvResponse, Error, UpdateEnvBody>({
    mutationFn: (body) => api.updateEnv(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'env'] }),
  })
}

export function useServiceStatus() {
  return useQuery<ServiceStatus>({
    queryKey: settingsKeys.service,
    queryFn: () => api.getServiceStatus(),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
}

function makeServiceMutation(
  fn: () => Promise<ServiceActionResponse>,
  qc: ReturnType<typeof useQueryClient>,
) {
  return useMutation<ServiceActionResponse, Error, void>({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.service }),
  })
}

export function useStartService() {
  const qc = useQueryClient()
  return makeServiceMutation(() => api.startService(), qc)
}

export function useStopService() {
  const qc = useQueryClient()
  return makeServiceMutation(() => api.stopService(), qc)
}

export function useRestartService() {
  const qc = useQueryClient()
  return makeServiceMutation(() => api.restartService(), qc)
}

/* ─────────────── Admin allowlist ─────────────── */

export function useAdminAllowlist() {
  return useQuery<AdminAllowlistResponse>({
    queryKey: settingsKeys.admins,
    queryFn: () => api.listAdminAllowlist(),
  })
}

export function useAddAdmin() {
  const qc = useQueryClient()
  return useMutation<AdminMutationResponse, Error, AddAdminBody>({
    mutationFn: (body) => api.addAdminAllowlist(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.admins }),
  })
}

export function useRemoveAdmin() {
  const qc = useQueryClient()
  return useMutation<AdminMutationResponse, Error, RemoveAdminBody>({
    mutationFn: (body) => api.removeAdminAllowlist(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.admins }),
  })
}

/* ─────────────── App config ─────────────── */

export function useConfig() {
  return useQuery<AppConfig>({
    queryKey: settingsKeys.config,
    queryFn: () => api.getConfig(),
  })
}

export function useUpdateConfig() {
  const qc = useQueryClient()
  return useMutation<AppConfig, Error, Partial<AppConfig>>({
    mutationFn: (body) => api.updateConfig(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.config }),
  })
}

/* ─────────────── Workspaces ─────────────── */

export function useWorkspaces() {
  return useQuery<{ workspaces: WorkspaceConfig[] }>({
    queryKey: settingsKeys.workspaces,
    queryFn: () => api.listWorkspacesFull(),
  })
}

export function useUpsertWorkspace() {
  const qc = useQueryClient()
  return useMutation<
    { ok: boolean; workspace: WorkspaceConfig },
    Error,
    WorkspaceConfig
  >({
    mutationFn: (body) => api.upsertWorkspace(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.workspaces }),
  })
}
