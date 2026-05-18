/**
 * /chat — agim's primary surface. Replaces the PR-5 placeholder.
 *
 * Layout: sticky topbar (agent picker + status dot + theme/lang) +
 * scrollable message list + bottom input pinned with safe-area
 * padding. Uses `min-h-dvh` so the soft keyboard pushes the input
 * up instead of overlaying it on iOS Safari.
 *
 * State: useChat() owns the WebSocket + reducer; the route is a
 * thin presenter — every interaction (send, switch-agent, approval
 * click) calls through. Theme + language come from the shell's
 * usePrefs store; lib/api/errors.ts handles the toast.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'

import { useChat } from '@/hooks/use-chat'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MessageBubble } from '@/components/chat/message-bubble'
import { AgentPicker } from '@/components/chat/agent-picker'
import { ThemeAndLangControls } from '@/components/shell/theme-lang-controls'
import { cn } from '@/lib/utils'

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-success',
  connecting: 'bg-warning animate-pulse',
  closed: 'bg-text-muted',
  error: 'bg-danger',
}

export default function ChatRoute(): JSX.Element {
  const { t } = useTranslation()
  const { state, send, switchAgent, approvalClick, clearError } = useChat()
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom on new messages OR streaming chunk. Use
  // requestAnimationFrame so the layout has settled before we scroll;
  // also tolerate the case where the user scrolled up intentionally.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (!nearBottom && state.currentReplyId == null) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [state.messages, state.currentReplyId])

  // Surface WS errors as toasts (and clear so they don't re-fire on
  // every render).
  useEffect(() => {
    if (!state.error) return
    toast.error(state.error)
    clearError()
  }, [state.error, clearError])

  function onSubmit(e?: React.FormEvent): void {
    e?.preventDefault()
    const v = input.trim()
    if (!v) return
    if (state.status !== 'open') {
      toast.error(t('chat.notConnected', { defaultValue: 'Not connected. Reconnecting…' }))
      return
    }
    send(v)
    setInput('')
    // Keep focus on mobile keyboards.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-bg">
      {/* Topbar */}
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-surface px-4 py-3 pt-safe shadow-sm">
        <span className="text-md font-semibold">
          <span className="mr-2">🤖</span>
          {t('appName')}
        </span>
        <span className={cn('inline-block h-2 w-2 rounded-full', STATUS_STYLES[state.status])} title={state.status} />
        <span className="hidden text-xs text-text-dim sm:inline">{state.status}</span>
        <div className="ml-auto flex items-center gap-2">
          <AgentPicker agents={state.agents} value={state.agent} onChange={switchAgent} />
          <ThemeAndLangControls />
        </div>
      </header>

      {/* Message list */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6 sm:px-6">
          {state.messages.length === 0 && state.status === 'open' && (
            <div className="grid place-items-center py-16 text-center">
              <div className="text-4xl">💬</div>
              <h2 className="mt-3 text-lg font-semibold">
                {t('chat.welcomeTitle', { defaultValue: 'Start a conversation' })}
              </h2>
              <p className="mt-1 max-w-md text-sm text-text-dim">
                {t('chat.welcomeBody', {
                  defaultValue:
                    'Type a message to ask the active agent. Use the agent dropdown to switch.',
                })}
              </p>
            </div>
          )}
          {state.messages.length === 0 && state.status !== 'open' && (
            <div className="grid place-items-center py-16 text-center">
              <AlertCircle className="h-10 w-10 text-text-muted" />
              <p className="mt-3 text-sm text-text-dim">
                {state.status === 'connecting'
                  ? t('chat.connecting', { defaultValue: 'Connecting to agim…' })
                  : t('chat.disconnected', {
                      defaultValue:
                        'Disconnected. Reconnecting automatically; you can keep typing.',
                    })}
              </p>
            </div>
          )}
          {state.messages.map((m) => (
            <MessageBubble key={m.id} msg={m} onApprove={approvalClick} />
          ))}
        </div>
      </div>

      {/* Input */}
      <form
        onSubmit={onSubmit}
        className="sticky bottom-0 border-t border-border bg-surface px-4 py-3 pb-safe sm:px-6"
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('chat.inputPlaceholder', {
              defaultValue: 'Message… (Enter sends, Shift+Enter newlines)',
            })}
            rows={1}
            className={cn(
              'flex-1 resize-none rounded-md border border-border bg-bg',
              'px-3 py-2 text-sm leading-6',
              'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg',
              'max-h-32 min-h-9',
            )}
          />
          <Button
            type="submit"
            size="icon"
            disabled={!input.trim() || state.status !== 'open'}
            aria-label={t('chat.send', { defaultValue: 'Send' })}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {state.currentReplyId && (
          <div className="mx-auto mt-2 flex max-w-3xl items-center gap-2">
            <Badge variant="info">
              {t('chat.streaming', { defaultValue: '… streaming' })}
            </Badge>
          </div>
        )}
      </form>
    </div>
  )
}
