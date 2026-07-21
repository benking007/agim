/**
 * Shared model / context stats for ComposerStatusBar (portal + desktop).
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import {
  estimateContextWindow,
  estimateTokensFromText,
  type ContextBreakdownItem,
  type ModelOption,
} from '@/components/chat/composer-status-bar'
import { useLlmList, type LlmBackendRow } from '@/hooks/use-llm-admin'
import type { ChatMessage } from '@/hooks/use-chat'
import { displayAgentName } from '@/components/m-portal/agent-visuals'

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

export function useComposerModelStatus(
  agent: string,
  messages: ChatMessage[],
  sessionModel = '',
) {
  const { t } = useTranslation()
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

  const contextUsed = useMemo(
    () => messages.reduce((n, m) => n + estimateTokensFromText(m.content || ''), 0),
    [messages],
  )
  const contextWindow = estimateContextWindow(active?.model)

  const breakdown = useMemo((): ContextBreakdownItem[] => {
    const conversation = contextUsed
    const system = isAgim ? 1_200 : 400
    return [
      {
        key: 'system',
        label: t('chat.statusBar.systemPrompt', { defaultValue: 'System prompt' }),
        tokens: system,
        color: '#a1a1aa',
      },
      {
        key: 'conversation',
        label: t('chat.statusBar.conversation', { defaultValue: 'Conversation' }),
        tokens: conversation,
        color: '#ef4444',
      },
    ]
  }, [contextUsed, isAgim, t])

  return {
    isAgim,
    modelLabel,
    modelMissing,
    modelOptions,
    activeBackendName,
    showThinking: isAgim,
    contextUsed: contextUsed + (isAgim ? 1_200 : 400),
    contextWindow,
    breakdown,
    refreshLlm: () => { void llm.refetch() },
  }
}
