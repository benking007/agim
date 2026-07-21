/**
 * Shared model / context stats for ComposerStatusBar (portal + desktop).
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import {
  estimateContextWindow,
  estimateTokensFromText,
  type ContextBreakdownItem,
} from '@/components/chat/composer-status-bar'
import { useLlmList } from '@/hooks/use-llm-admin'
import type { ChatMessage } from '@/hooks/use-chat'
import { displayAgentName } from '@/components/m-portal/agent-visuals'

export function useComposerModelStatus(agent: string, messages: ChatMessage[]) {
  const { t } = useTranslation()
  const llm = useLlmList()

  const isAgim = agent === 'agim' || agent === 'native'
  const usable = (llm.data?.backends ?? []).filter((b) => b.secret.source !== 'none')
  const nativeRole = llm.data?.roles?.['native-chat']
  const active = usable.find((b) => b.name === nativeRole) ?? usable[0]

  const modelLabel = isAgim
    ? (active?.model
      || t('chat.statusBar.noModel', { defaultValue: 'Configure model' }))
    : (agent
      ? displayAgentName(agent)
      : t('chat.statusBar.noAgent', { defaultValue: 'No agent' }))

  const modelMissing = isAgim && !active

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
    showThinking: isAgim,
    contextUsed: contextUsed + (isAgim ? 1_200 : 400),
    contextWindow,
    breakdown,
    refreshLlm: () => { void llm.refetch() },
  }
}
