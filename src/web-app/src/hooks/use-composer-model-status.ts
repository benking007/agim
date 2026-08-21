/**
 * Shared model / context stats for ComposerStatusBar (portal + desktop).
 */

import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import {
  estimateContextWindow,
  type ContextBreakdownItem,
  type ModelOption,
} from '@/components/chat/composer-status-bar'
import { displayAgentName } from '@/components/m-portal/agent-visuals'
import type { ChatMessage } from '@/hooks/use-chat'
import { useLlmList, type LlmBackendRow, type McpListResponse } from '@/hooks/use-llm-admin'
import type { AgimSkillsInjectionResponse } from '@/hooks/use-agim-skills'
import { client } from '@/lib/api/client'
import { api } from '@/lib/api/endpoints'
import {
  applyMeasuredContextTokens,
  buildContextBreakdown,
  resolveContextUsedTokens,
} from '@/lib/context-breakdown'
import type { WorkspaceFilesResponse } from '@/types/api'

function pickActiveBackend(
  backends: LlmBackendRow[],
  usable: LlmBackendRow[],
  nativeRole: string | undefined,
  sessionModel: string,
): LlmBackendRow | undefined {
  if (sessionModel.trim()) {
    const bySession = usable.find((b) => b.name === sessionModel)
      ?? backends.find((b) => b.name === sessionModel)
    if (bySession) return bySession
  }
  return usable.find((b) => b.name === nativeRole)
    ?? usable[0]
    ?? backends.find((b) => b.name === nativeRole)
    ?? backends[0]
}

/** Sibling backends under the same preset label (or same baseUrl). */
function siblingBackends(active: LlmBackendRow | undefined, usable: LlmBackendRow[]): LlmBackendRow[] {
  if (!active) return usable
  if (active.label) {
    const same = usable.filter((b) => b.label === active.label)
    if (same.length > 0) return same
  }
  if (active.baseUrl) {
    const same = usable.filter((b) => b.baseUrl === active.baseUrl)
    if (same.length > 0) return same
  }
  return usable.length > 0 ? usable : (active ? [active] : [])
}

function fileChars(data: WorkspaceFilesResponse | undefined): number {
  if (data?.type !== 'file') return 0
  if (typeof data.size === 'number' && data.size > 0) return data.size
  return data.content?.length ?? 0
}

const RULE_PATHS = ['AGENTS.md', 'AGENTS.local.md', 'MEMORY.md'] as const

export function useComposerModelStatus(
  agent: string,
  messages: ChatMessage[],
  sessionModel = '',
  contextTokensMeasured: number | null = null,
) {
  const { t, i18n } = useTranslation()
  const llm = useLlmList()

  const isAgim = agent === 'agim' || agent === 'native'
  const backends = llm.data?.backends ?? []
  const usable = backends.filter((b) => b.secret.source !== 'none')
  const nativeRole = llm.data?.roles?.['native-chat']
  const active = pickActiveBackend(backends, usable, nativeRole, sessionModel)

  const modelOptions = useMemo((): ModelOption[] => {
    if (!isAgim) return []
    const rows = (llm.data?.backends ?? []).filter((b) => b.secret.source !== 'none')
    const current = pickActiveBackend(
      llm.data?.backends ?? [],
      rows,
      llm.data?.roles?.['native-chat'],
      sessionModel,
    )
    return siblingBackends(current, rows).map((b) => ({
      backendName: b.name,
      model: b.model,
    }))
  }, [isAgim, llm.data, sessionModel])

  const modelLabel = isAgim
    ? (active?.model
      || t('chat.statusBar.noModel', { defaultValue: 'Configure model' }))
    : (agent
      ? displayAgentName(agent)
      : t('chat.statusBar.noAgent', { defaultValue: 'No agent' }))

  const modelMissing = isAgim && (!active || active.secret.source === 'none')
  const activeBackendName = active?.name

  // Prefer the configured backend contextWindow (custom / vendor override).
  const contextWindow = typeof active?.contextWindow === 'number' && active.contextWindow > 0
    ? active.contextWindow
    : estimateContextWindow(active?.model)

  // Best-effort extras for Cursor-like buckets (admin APIs may 403 — ignore).
  const ruleQueries = useQueries({
    queries: RULE_PATHS.map((path) => ({
      queryKey: ['usage', 'rules', path] as const,
      queryFn: async (): Promise<number> => {
        try {
          const data = await api.getWorkspaceFiles({ agent: 'agim', path })
          return fileChars(data)
        } catch {
          return 0
        }
      },
      enabled: isAgim,
      retry: false,
      staleTime: 60_000,
    })),
  })

  const skillsQuery = useQuery({
    queryKey: ['usage', 'skills-injection'] as const,
    queryFn: async (): Promise<number> => {
      try {
        const data = await client.get<AgimSkillsInjectionResponse>('/api/agim-skills/injection')
        if (data.overrideActive && data.overrideChars > 0) return data.overrideChars
        return data.autoChars || 0
      } catch {
        return 0
      }
    },
    enabled: isAgim,
    retry: false,
    staleTime: 60_000,
  })

  const mcpQuery = useQuery({
    queryKey: ['usage', 'mcp-tools'] as const,
    queryFn: async (): Promise<number> => {
      try {
        const data = await client.get<McpListResponse>('/api/mcp')
        return data.runtime?.totalTools ?? 0
      } catch {
        return 0
      }
    },
    enabled: isAgim,
    retry: false,
    staleTime: 60_000,
  })

  const rulesChars = ruleQueries.reduce((n, q) => n + (q.data ?? 0), 0)
  const skillsChars = skillsQuery.data ?? 0
  const mcpToolCount = mcpQuery.data ?? 0

  const zh = (i18n.language || '').startsWith('zh')

  const buckets = useMemo(
    () => applyMeasuredContextTokens(
      buildContextBreakdown({
        isAgim,
        messages,
        rulesChars,
        skillsChars,
        mcpToolCount,
      }),
      contextTokensMeasured,
    ),
    [isAgim, messages, rulesChars, skillsChars, mcpToolCount, contextTokensMeasured],
  )

  const breakdown = useMemo((): ContextBreakdownItem[] => {
    const labelFor = (key: string): string => {
      switch (key) {
        case 'system':
          return t('chat.statusBar.systemPrompt', { defaultValue: zh ? '系统提示' : 'System prompt' })
        case 'tools':
          return t('chat.statusBar.toolDefs', { defaultValue: zh ? '工具定义' : 'Tool definitions' })
        case 'rules':
          return t('chat.statusBar.rules', { defaultValue: zh ? '规则' : 'Rules' })
        case 'skills':
          return t('chat.statusBar.skills', { defaultValue: zh ? '技能' : 'Skills' })
        case 'mcp':
          return t('chat.statusBar.mcpTools', {
            defaultValue: zh ? 'MCP 与动态工具' : 'MCP & dynamic tools',
          })
        case 'subagents':
          return t('chat.statusBar.subagents', {
            defaultValue: zh ? '子代理定义' : 'Subagent definitions',
          })
        case 'summarized':
          return t('chat.statusBar.summarized', {
            defaultValue: zh ? '已压缩对话' : 'Summarized conversation',
          })
        case 'conversation':
          return t('chat.statusBar.conversation', {
            defaultValue: zh ? '对话（含工具结果）' : 'Conversation (incl. tools)',
          })
        default:
          return key
      }
    }
    return buckets.map((b) => ({
      key: b.key,
      label: labelFor(b.labelKey),
      tokens: b.tokens,
      color: b.color,
    }))
  }, [buckets, t, zh])

  const contextUsed = useMemo(
    () => resolveContextUsedTokens(buckets, contextTokensMeasured),
    [buckets, contextTokensMeasured],
  )

  return {
    isAgim,
    modelLabel,
    modelMissing,
    modelOptions,
    activeBackendName,
    showThinking: isAgim,
    contextUsed,
    contextWindow,
    breakdown,
    contextMeasured: typeof contextTokensMeasured === 'number' && contextTokensMeasured > 0,
    refreshLlm: () => { void llm.refetch() },
  }
}
