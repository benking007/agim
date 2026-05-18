/**
 * useWorkspace — agent picker source + per-agent file browser +
 * write mutation.
 *
 *   useAgentsStatus()                      — populate the picker
 *   useWorkspaceFiles(agent, path)         — dir listing or file
 *                                            content (discriminated
 *                                            by `type`)
 *   useWriteWorkspaceFile()                — PUT a file
 *
 * Both reads stay cached at the default 30s staleTime; the write
 * invalidates so the saved size/mtime re-paint immediately.
 */

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import type {
  WorkspaceFilesResponse,
  WriteWorkspaceFileBody,
  WriteWorkspaceFileResponse,
} from '@/types/api'

export const workspaceKeys = {
  all:   ['workspace'] as const,
  files: (agent: string, path: string) =>
    ['workspace', 'files', agent, path] as const,
}

export function useAgentsStatus() {
  return useQuery<Record<string, boolean>>({
    queryKey: ['agents', 'status'],
    queryFn: () => api.getAgentsStatus(),
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
