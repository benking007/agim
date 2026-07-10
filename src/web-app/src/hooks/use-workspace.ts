/**
 * useWorkspace — agent picker source + per-agent file browser +
 * write mutation.
 *
 *   useAgentsStatus()                      — online state by agent id
 *   useAgentCatalog()                      — built-in display/install metadata
 *   useWorkspaceFiles(agent, path)         — dir listing or file content
 *   useWriteWorkspaceFile()                — PUT a file
 *
 * Reads stay cached at the default 30s staleTime; writes invalidate so the
 * saved size/mtime re-paints immediately.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import { getAgentCatalog } from '@/lib/api/agent-catalog'
import type {
  WorkspaceFilesResponse,
  WriteWorkspaceFileBody,
  WriteWorkspaceFileResponse,
} from '@/types/api'

export const workspaceKeys = {
  all: ['workspace'] as const,
  files: (agent: string, path: string) =>
    ['workspace', 'files', agent, path] as const,
}

export function useAgentsStatus() {
  return useQuery<Record<string, boolean>>({
    queryKey: ['agents', 'status'],
    queryFn: () => api.getAgentsStatus(),
  })
}

export function useAgentCatalog() {
  return useQuery({
    queryKey: ['agents', 'catalog'],
    queryFn: getAgentCatalog,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useWorkspaceFiles(
  agent: string,
  path: string,
  opts: { enabled?: boolean } = {},
) {
  return useQuery<WorkspaceFilesResponse>({
    queryKey: workspaceKeys.files(agent, path),
    queryFn: () => api.getWorkspaceFiles({ agent, ...(path ? { path } : {}) }),
    enabled: opts.enabled !== false && Boolean(agent),
  })
}

export function useInvalidateWorkspace() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: workspaceKeys.all })
}

export function useWriteWorkspaceFile() {
  const qc = useQueryClient()
  return useMutation<
    WriteWorkspaceFileResponse,
    Error,
    { agent: string; path: string; body: WriteWorkspaceFileBody }
  >({
    mutationFn: ({ agent, path, body }) =>
      api.writeWorkspaceFile({ agent, path }, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  })
}
