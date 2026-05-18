/**
 * MessageBubble — one chat message (user, assistant, or system/approval).
 * Renders content + role + timestamp. Approval cards render an inline
 * card with Allow / Deny buttons.
 *
 * No markdown for now — that lands in a follow-up PR with a vetted
 * sanitizer. Plain text + preserved whitespace is correct enough for
 * agim's debugging-focused chat surface.
 */

import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { ChatMessage } from '@/hooks/use-chat'

export interface MessageBubbleProps {
  msg: ChatMessage
  onApprove?: (messageId: string, decision: 'allow' | 'deny') => void
}

export function MessageBubble({ msg, onApprove }: MessageBubbleProps): JSX.Element {
  const { t } = useTranslation()

  if (msg.approval) {
    const { messageId, prompt, outcome } = msg.approval
    return (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-warning bg-warning-bg p-4">
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="warning">{t('chat.approvalTitle', { defaultValue: '🔐 Tool approval' })}</Badge>
        </div>
        <pre className="whitespace-pre-wrap break-words text-sm text-text">{prompt}</pre>
        {outcome ? (
          <div className="mt-3 text-sm">
            {outcome === 'allow' && (
              <Badge variant="success">{t('chat.approvalAllowed', { defaultValue: '✅ Allowed' })}</Badge>
            )}
            {outcome === 'deny' && (
              <Badge variant="danger">{t('chat.approvalDenied', { defaultValue: '❌ Denied' })}</Badge>
            )}
            {outcome === 'timeout' && (
              <Badge variant="danger">{t('chat.approvalTimeout', { defaultValue: '⏱ Timed out' })}</Badge>
            )}
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onApprove?.(messageId, 'allow')}>
              {t('chat.approvalAllow', { defaultValue: 'Allow' })}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => onApprove?.(messageId, 'deny')}>
              {t('chat.approvalDeny', { defaultValue: 'Deny' })}
            </Button>
          </div>
        )}
      </div>
    )
  }

  const isUser = msg.role === 'user'
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] sm:max-w-[75%] rounded-lg px-4 py-3 shadow-sm',
          isUser
            ? 'bg-accent text-accent-fg'
            : 'bg-surface text-text border border-border',
        )}
      >
        {!isUser && msg.agent && (
          <div className="mb-1 text-xs font-medium text-text-muted">{msg.agent}</div>
        )}
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {msg.content || (msg.role === 'assistant' && (
            <span className="inline-block animate-pulse text-text-dim">…</span>
          ))}
        </div>
      </div>
    </div>
  )
}
