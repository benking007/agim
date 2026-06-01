/**
 * /m/chat — agim mobile chat surface (v1.2.129).
 *
 * Reuses the desktop useChat() hook + MessageBubble + ApprovalDock so
 * the feature matrix matches /chat exactly (send, stream, switch agent,
 * approvals, new conversation, status indicator). Only the chrome
 * changes — the page lives OUTSIDE the admin shell, has a single
 * mobile-tuned topbar, and the input bar uses pb-safe to clear the
 * iOS home indicator + the soft keyboard.
 *
 * Layout reference: Claude Code mobile (the screenshot shared with the
 * v1.2.129 spec). Five elements: back chevron + thread title with
 * subtitle + ⋯ action menu, scroll list with auto-scroll-to-bottom,
 * floating "↓" when the user scrolled up, approval dock above input,
 * bottom input with pb-safe.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ChevronLeft, MoreVertical, Send } from 'lucide-react'
import { toast } from 'sonner'

import { useChat } from '@/hooks/use-chat'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MessageBubble } from '@/components/chat/message-bubble'
import { ApprovalDock } from '@/components/chat/approval-dock'
import { AgentPicker } from '@/components/chat/agent-picker'
import { cn } from '@/lib/utils'

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-success',
  connecting: 'bg-warning animate-pulse',
  closed: 'bg-text-muted',
  error: 'bg-danger',
}

export default function MobileChatRoute(): JSX.Element {
  const { t } = useTranslation(['chat', 'common'])
  const {
    state, send, switchAgent, approvalClick, newConversation, clearError,
  } = useChat()
  const [input, setInput] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [showScrollDown, setShowScrollDown] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const textareaWrapperRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new messages OR streaming chunk. Same
  // pinch-tolerance as the desktop route: if the user scrolled up
  // more than 200px we hold position (until they tap the ↓ button).
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom > 200 && state.currentReplyId == null) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [state.messages, state.currentReplyId])

  // Floating "scroll to bottom" pill — show iff the user is more than
  // 200px above the bottom. Re-evaluate on scroll + on every list
  // mutation (covered by the auto-scroll effect above).
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = (): void => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollDown(dist > 200)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Surface WS errors as toasts (and clear so they don't re-fire on
  // every render). Same pattern as the desktop route.
  useEffect(() => {
    if (!state.error) return
    toast.error(state.error)
    clearError()
  }, [state.error, clearError])

  // Auto-grow the textarea up to 6 lines, then scroll.
  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 24 * 6 + 16)}px`
  }, [input])

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
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // IME-safe: never submit while a Chinese / Japanese / Korean
    // composition span is active. Same guard as /chat — see comments
    // there for the keyCode === 229 legacy fallback rationale.
    const ne = e.nativeEvent as KeyboardEvent & { isComposing?: boolean }
    if (ne.isComposing || e.keyCode === 229) return
    // Mobile: Enter inserts newline, send is the explicit button.
    // Most mobile keyboards expose a separate Send key only via the
    // virtual keyboard's submit action — which already triggers our
    // form submit on iOS Safari. Don't hijack Enter.
  }

  function onScrollToBottom(): void {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  function onLogout(): void {
    void fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
      try { localStorage.removeItem('agim_token') } catch { /* noop */ }
      // Cookie was cleared by the server, but force a fresh load too.
      window.location.replace('/login')
    })
  }

  return (
    <div className="flex h-dvh flex-col bg-bg">
      {/* Topbar — flat, single row. Left: back chevron. Center: title
          + subtitle. Right: actions menu. Topbar is bg-surface to give
          it a paper-feel vs. the bg behind messages. */}
      <header
        className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
      >
        <Button
          variant="ghost" size="sm"
          aria-label={t('chat.back', { defaultValue: 'Back' })}
          onClick={() => window.history.length > 1 ? window.history.back() : window.location.assign('/')}
          className="h-9 w-9 p-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col items-center">
          <span className="truncate text-sm font-semibold">
            {t('chat.mobileTitle', { defaultValue: 'agim chat' })}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-text-dim">
            <span
              className={cn('inline-block h-1.5 w-1.5 rounded-full', STATUS_STYLES[state.status])}
            />
            <span>{state.agent}</span>
            <span>·</span>
            <span>{state.status}</span>
          </span>
        </div>
        <div className="relative">
          <Button
            variant="ghost" size="sm"
            aria-label={t('chat.menu', { defaultValue: 'Menu' })}
            onClick={() => setMenuOpen((v) => !v)}
            className="h-9 w-9 p-0"
          >
            <MoreVertical className="h-5 w-5" />
          </Button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setMenuOpen(false)}
                aria-hidden
              />
              <div
                className="absolute right-0 top-10 z-40 w-56 rounded-md border border-border bg-surface p-2 shadow-lg"
                role="menu"
              >
                <div className="px-2 py-1 text-[11px] uppercase text-text-dim">
                  {t('chat.agent', { defaultValue: 'Agent' })}
                </div>
                <div className="px-1 pb-2">
                  <AgentPicker
                    agents={state.agents}
                    value={state.agent}
                    onChange={(a) => { switchAgent(a); setMenuOpen(false) }}
                  />
                </div>
                <button
                  type="button"
                  className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50"
                  disabled={state.status !== 'open'}
                  onClick={() => {
                    newConversation()
                    setMenuOpen(false)
                    toast.success(t('chat.newConvToast', { defaultValue: 'Started a new conversation' }))
                  }}
                >
                  {t('chat.newConv', { defaultValue: 'New conversation' })}
                </button>
                <button
                  type="button"
                  className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-surface-hover"
                  onClick={onLogout}
                >
                  {t('chat.logout', { defaultValue: 'Log out' })}
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Message list */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2 px-3 py-3">
          {state.messages.length === 0 && state.status === 'open' && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-2xl">
                💬
              </div>
              <h2 className="text-base font-semibold">
                {t('chat.welcomeTitle', { defaultValue: 'Start a conversation' })}
              </h2>
              <p className="max-w-xs text-sm text-text-dim">
                {t('chat.welcomeBodyMobile', {
                  defaultValue: 'Type a message below. Switch agent or start over from the ⋯ menu.',
                })}
              </p>
            </div>
          )}
          {state.messages.length === 0 && state.status !== 'open' && (
            <div className="grid place-items-center py-16 text-center">
              <p className="text-sm text-text-dim">
                {state.status === 'connecting'
                  ? t('chat.connecting', { defaultValue: 'Connecting to agim…' })
                  : t('chat.disconnected', {
                      defaultValue: 'Disconnected. Reconnecting automatically.',
                    })}
              </p>
            </div>
          )}
          {state.messages
            .filter((m) => !m.approval)
            .map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                onApprove={(mid, reqId, choice) => approvalClick(mid, reqId, choice)}
              />
            ))}
        </div>
      </div>

      {/* Floating scroll-to-bottom pill. Position keeps it clear of
          the input bar (~80px above bottom). */}
      {showScrollDown && (
        <button
          type="button"
          onClick={onScrollToBottom}
          className="absolute bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-surface p-2 shadow-md"
          aria-label={t('chat.scrollDown', { defaultValue: 'Scroll to bottom' })}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}

      <ApprovalDock
        approvals={state.pendingApprovals}
        onApprove={(mid, reqId, choice) => approvalClick(mid, reqId, choice)}
      />

      {/* Input bar — sticky, safe-area aware. */}
      <form
        onSubmit={onSubmit}
        className="sticky bottom-0 border-t border-border bg-surface px-3 py-2"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.5rem)' }}
      >
        <div ref={textareaWrapperRef} className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('chat.inputPlaceholderMobile', {
              defaultValue: 'Message…',
            })}
            rows={1}
            className={cn(
              'flex-1 resize-none rounded-2xl border border-border bg-bg',
              'px-3 py-2 text-[15px] leading-6',
              'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg',
            )}
          />
          <Button
            type="submit"
            disabled={!input.trim() || state.status !== 'open'}
            aria-label={t('chat.send', { defaultValue: 'Send' })}
            className="h-10 w-10 shrink-0 rounded-full p-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {state.currentReplyId && (
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="info">
              {t('chat.streaming', { defaultValue: '… streaming' })}
            </Badge>
          </div>
        )}
      </form>
    </div>
  )
}
