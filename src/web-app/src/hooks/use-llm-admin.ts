/**
 * use-llm-admin / use-mcp-admin — react-query wrappers for the
 * Stage 6 LLM + MCP configuration REST surfaces.
 *
 * Intentionally NOT generated through endpoints.json — the panels are
 * the only consumers, the shapes are small, and a hand-written hook
 * keeps the diff manageable without churning the generated endpoints
 * file. When the panels stabilize we can promote them to endpoints.json
 * for type-checked round-tripping.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '@/lib/api/client'
import { onboardingKeys } from '@/hooks/use-onboarding'

// ─── LLM types (mirror the backend wire shapes) ──────────────────

export type LlmThinkingFormat = 'off' | 'deepseek' | 'openai'
export type LlmMaxTokensField = 'max_tokens' | 'max_completion_tokens'

export interface LlmBackendRow {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl?: string
  model: string
  /** Preset key when created via quick-enable (deepseek / …). */
  label?: string
  temperature?: number
  maxTokens?: number
  contextWindow?: number
  thinkingFormat?: LlmThinkingFormat
  maxTokensField?: LlmMaxTokensField
  extraHeaders?: Record<string, string>
  secret: {
    source: 'env' | 'file' | 'vendor' | 'none'
    envKey: string
    vendorEnvName?: string
    vendorCandidates?: string[]
  }
}

export interface LlmListResponse {
  backends: LlmBackendRow[]
  roles: Record<string, string>
}

export interface LlmAddBody {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  apiKey: string
  temperature?: number
  maxTokens?: number
  contextWindow?: number
  thinkingFormat?: LlmThinkingFormat | 'auto'
  maxTokensField?: LlmMaxTokensField | 'auto'
  /** Object or `Header: value` lines (server accepts both). */
  extraHeaders?: Record<string, string> | string
}

export interface LlmQuickEnableBody {
  apiKey: string
  preset?: string
  name?: string
  model?: string
  baseUrl?: string
  /** DeepSeek: openai (default) or anthropic Messages dialect. */
  dialect?: 'openai' | 'anthropic'
  /** DeepSeek: beta strict tool schemas. */
  strictTools?: boolean
  bindCheapRoles?: boolean
  setDefaultAgent?: boolean
}

export interface LlmQuickEnableResult {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  backends?: Array<{ name: string; model: string }>
  roles: Record<string, string>
  defaultAgent: string
  preset: string
  dialect?: 'openai' | 'anthropic'
  strictTools?: boolean
}

export interface LlmPingResponse {
  name: string
  ok: boolean
  durationMs?: number
  tokensIn?: number
  tokensOut?: number
  sampleText?: string
  error?: string
}

export type LlmPresetKey = 'deepseek' | 'moonshot' | 'zhipu' | 'mimo' | 'custom'

/** Wire shape from GET /api/llm/presets (backend SSOT). */
export interface LlmPresetRow {
  key: LlmPresetKey
  label?: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  cheapModel?: string
  models?: string[]
  baseName: string
  apiKeyDoc?: string
  defaultThinking?: 'off' | 'high' | 'max'
}

export interface LlmPresetsResponse {
  defaultPreset: LlmPresetKey
  presets: LlmPresetRow[]
}

const llmKeys = {
  all:  ['llm'] as const,
  list: ['llm', 'list'] as const,
  presets: ['llm', 'presets'] as const,
}

export function useLlmList() {
  return useQuery<LlmListResponse>({
    queryKey: llmKeys.list,
    queryFn: () => client.get<LlmListResponse>('/api/llm'),
  })
}

/** CR M1 — runtime SSOT for vendor presets (fallback handled by callers). */
export function useLlmPresets() {
  return useQuery<LlmPresetsResponse>({
    queryKey: llmKeys.presets,
    queryFn: () => client.get<LlmPresetsResponse>('/api/llm/presets'),
    staleTime: 60_000,
  })
}

export function useLlmAddBackend() {
  const qc = useQueryClient()
  return useMutation<{ name: string; secretStored: boolean }, Error, LlmAddBody>({
    mutationFn: (body) => client.post('/api/llm/backends', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.all }),
  })
}

export function useLlmQuickEnable() {
  const qc = useQueryClient()
  return useMutation<LlmQuickEnableResult, Error, LlmQuickEnableBody>({
    mutationFn: (body) => client.post('/api/llm/quick-enable', { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: llmKeys.all })
      void qc.invalidateQueries({ queryKey: onboardingKeys.status })
    },
  })
}

export interface LlmSyncPresetResult {
  preset: string
  added: Array<{ name: string; model: string }>
}

/** Add catalog models that an already-installed vendor group is missing. */
export function useLlmSyncPreset() {
  const qc = useQueryClient()
  return useMutation<LlmSyncPresetResult, Error, { preset: string }>({
    mutationFn: (body) => client.post('/api/llm/presets/sync', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.all }),
  })
}

export function useLlmRemoveBackend() {
  const qc = useQueryClient()
  return useMutation<{ removedRoles: number }, Error, string>({
    mutationFn: (name) => client.delete(`/api/llm/backends/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.all }),
  })
}

export type LlmRemoveGroupBody =
  | { label: string; names?: undefined }
  | { names: string[]; label?: undefined }

/** CR M2 — one-shot atomic group / multi delete. */
export function useLlmRemoveBackendGroup() {
  const qc = useQueryClient()
  return useMutation<
    { removed: string[]; removedRoles: number },
    Error,
    LlmRemoveGroupBody
  >({
    mutationFn: (body) => {
      if ('label' in body && body.label) {
        return client.delete(`/api/llm/backends?label=${encodeURIComponent(body.label)}`)
      }
      const names = body.names ?? []
      return client.delete(`/api/llm/backends?names=${encodeURIComponent(names.join(','))}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.all }),
  })
}

export function useLlmPutRoles() {
  const qc = useQueryClient()
  return useMutation<{ roles: Record<string, string> }, Error, Record<string, string | null>>({
    mutationFn: (body) => client.put('/api/llm/roles', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.all }),
  })
}

export function useLlmSetSecret() {
  const qc = useQueryClient()
  return useMutation<{ name: string; source: 'env' | 'file' | 'none' }, Error, { name: string; apiKey: string }>({
    mutationFn: ({ name, apiKey }) => client.post(
      `/api/llm/secrets/${encodeURIComponent(name)}`, { body: { apiKey } },
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.all }),
  })
}

export function useLlmPing() {
  return useMutation<LlmPingResponse, Error, string>({
    mutationFn: (name) => client.post(`/api/llm/backends/${encodeURIComponent(name)}/ping`),
  })
}

// ─── MCP types (mirror the backend wire shapes) ──────────────────

export interface McpServerRow {
  name: string
  command?: string
  args?: string[]
  url?: string
  enabled?: boolean
}

export interface McpRuntime {
  servers: Array<{ name: string; connected: boolean; toolCount: number; error?: string }>
  totalTools: number
}

export interface McpListResponse {
  servers: McpServerRow[]
  runtime: McpRuntime
}

export interface McpAddBody {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

export interface McpHealthResponse {
  name: string
  connected: boolean
  toolCount: number
  lastError?: string
}

const mcpKeys = {
  all:  ['mcp'] as const,
  list: ['mcp', 'list'] as const,
}

export function useMcpList() {
  return useQuery<McpListResponse>({
    queryKey: mcpKeys.list,
    queryFn: () => client.get<McpListResponse>('/api/mcp'),
  })
}

export function useMcpAddServer() {
  const qc = useQueryClient()
  return useMutation<{ name: string }, Error, McpAddBody>({
    mutationFn: (body) => client.post('/api/mcp/servers', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.all }),
  })
}

export function useMcpRemoveServer() {
  const qc = useQueryClient()
  return useMutation<{ name: string }, Error, string>({
    mutationFn: (name) => client.delete(`/api/mcp/servers/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.all }),
  })
}

export function useMcpHealth() {
  const qc = useQueryClient()
  return useMutation<McpHealthResponse, Error, string>({
    mutationFn: (name) => client.post(`/api/mcp/servers/${encodeURIComponent(name)}/health`),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.all }),
  })
}

export function useMcpReload() {
  const qc = useQueryClient()
  return useMutation<{ connected: number }, Error, void>({
    mutationFn: () => client.post('/api/mcp/reload'),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.all }),
  })
}
