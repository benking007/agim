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
import { Send, AlertCircle, MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'

import { useChat } from '@/hooks/use-chat'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MessageBubble } from '@/components/chat/message-bubble'
import { AgentPicker } from '@/components/chat/agent-picker'
import { Topbar } from '@/components/shell/topbar'
import { cn } from '@/lib/utils'

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-success',
  connecting: 'bg-warning animate-pulse',
  closed: 'bg-text-muted',
  error: 'bg-danger',
}

export default function ChatRoute(): JSX.Element {
  const { t } = useTranslation()
  const {
    state, send, switchAgent, approvalClick, newConversation, clearError,
  } = useChat()
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
    // Respect IME composition: CJK input methods use Enter to commit
    // candidates. Without this guard, pressing Enter to confirm a
    // Chinese candidate would also submit the message — the textarea
    // sees an Enter event the IME hasn't yet "consumed". `isComposing`
    // is true while the composition span is active; `keyCode === 229`
    // is the legacy fallback for browsers that don't expose the flag.
    const ne = e.nativeEvent as KeyboardEvent & { isComposing?: boolean }
    if (ne.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-bg">
      {/* App-wide Topbar (brand + nav + theme/lang). Chat-specific
          chrome — WS status pill + agent picker — slots into the
          children prop so it stays on the right of the topbar. */}
      <Topbar>
        <span
          className={cn('inline-block h-2 w-2 rounded-full', STATUS_STYLES[state.status])}
          title={state.status}
        />
        <span className="hidden text-xs text-text-dim sm:inline">{state.status}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            newConversation()
            toast.success(t('chat.newConvToast', { defaultValue: 'Started a new conversation' }))
            requestAnimationFrame(() => inputRef.current?.focus())
          }}
          disabled={state.status !== 'open'}
          title={t('chat.newConvHint', {
            defaultValue: 'Clear messages and start a fresh session',
          })}
          aria-label={t('chat.newConv', { defaultValue: 'New conversation' })}
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="hidden text-xs sm:inline">
            {t('chat.newConv', { defaultValue: 'New' })}
          </span>
        </Button>
        <AgentPicker agents={state.agents} value={state.agent} onChange={switchAgent} />
      </Topbar>

      {/* Message list */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-3 py-3 sm:px-4">
          {state.messages.length === 0 && state.status === 'open' && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-2xl">
                💬
              </div>
              <h2 className="text-base font-semibold">
                {t('chat.welcomeTitle', { defaultValue: 'Start a conversation' })}
              </h2>
              <p className="max-w-md text-sm text-text-dim">
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
            <MessageBubble
              key={m.id}
              msg={m}
              onApprove={(mid, reqId, choice) => approvalClick(mid, reqId, choice)}
            />
          ))}
        </div>
      </div>

      {/* Input — height matches the h-8 topbar widgets (agent picker /
          lang select / theme button) so the whole chat surface has one
          consistent vertical rhythm. */}
      <form
        onSubmit={onSubmit}
        className="sticky bottom-0 border-t border-border bg-surface px-4 py-2 pb-safe sm:px-6"
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
              'px-3 py-1.5 text-sm leading-5',
              'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg',
              'max-h-32 min-h-8',
            )}
          />
          <Button
            type="submit"
            disabled={!input.trim() || state.status !== 'open'}
            aria-label={t('chat.send', { defaultValue: 'Send' })}
            className="h-8 w-8 p-0"
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
