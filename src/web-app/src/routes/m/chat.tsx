/**
 * /m/chat — mobile-first chat surface (production-oriented UX pass).
 *
 * Upgrades over v1:
 *   - richer hierarchy (thread title + status + execution rail)
 *   - date separators + per-message timestamps
 *   - quick prompts + larger mobile composer controls
 *   - bottom-sheet menu and activity panel for recent runs
 *
 * Keeps compatibility with the existing useChat() transport:
 *   same message flow / approvals / reconnect behavior.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  ArrowDown,
  ChevronLeft,
  Clock3,
  Loader2,
  MoreVertical,
  Sparkles,
  Send,
} from 'lucide-react'
import { toast } from 'sonner'

import { useChat, type ChatMessage, type RunActivity } from '@/hooks/use-chat'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MessageBubble } from '@/components/chat/message-bubble'
import { ApprovalDock } from '@/components/chat/approval-dock'
import { AgentPicker } from '@/components/chat/agent-picker'
import { isNativeSetupError } from '@/components/chat/error-hints'
import { NativeSetupDialog } from '@/components/chat/native-setup-dialog'
import { agentDisplayName } from '@/lib/agent-label'
import { cn } from '@/lib/utils'

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-success',
  connecting: 'bg-warning animate-pulse',
  closed: 'bg-text-muted',
  error: 'bg-danger',
}

type SheetMode = 'none' | 'menu' | 'activity'
type MessageRow =
  | { type: 'divider'; key: string; label: string }
  | { type: 'message'; key: string; msg: ChatMessage }

function safeTs(ts: number): number {
  return Number.isFinite(ts) ? ts : Date.now()
}

function dayKey(ts: number): string {
  const d = new Date(safeTs(ts))
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function formatDay(ts: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(safeTs(ts)))
}

function formatClock(ts: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(safeTs(ts)))
}

function formatDurationMs(ms?: number): string {
  if (!ms || ms <= 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
}

function buildRows(messages: ChatMessage[], locale: string): MessageRow[] {
  const rows: MessageRow[] = []
  let prevDay = ''
  for (const msg of messages) {
    const k = dayKey(msg.timestamp)
    if (k !== prevDay) {
      rows.push({ type: 'divider', key: `d-${k}`, label: formatDay(msg.timestamp, locale) })
      prevDay = k
    }
    rows.push({ type: 'message', key: msg.id, msg })
  }
  return rows
}

function runStatusBadgeClass(status: RunActivity['status']): string {
  switch (status) {
    case 'running': return 'bg-info-bg text-info'
    case 'success': return 'bg-success-bg text-success'
    case 'error': return 'bg-danger-bg text-danger'
  }
}

export default function MobileChatRoute(): JSX.Element {
  const { t, i18n } = useTranslation(['chat', 'common'])
  const {
    state, send, switchAgent, approvalClick, newConversation, clearError,
  } = useChat()
  const [input, setInput] = useState('')
  const [sheet, setSheet] = useState<SheetMode>('none')
  const [showScrollDown, setShowScrollDown] = useState(false)
  const [nativeSetupDialogOpen, setNativeSetupDialogOpen] = useState(false)
  const [nativeSetupReason, setNativeSetupReason] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const statusLabel = t(`chat.status.${state.status}`, { defaultValue: state.status })

  const quickPrompts = useMemo(
    () => [
      t('chat.quickPrompt.plan'),
      t('chat.quickPrompt.risks'),
      t('chat.quickPrompt.summary'),
    ],
    [t],
  )

  const chatMessages = useMemo(
    () => state.messages.filter((m) => !m.approval),
    [state.messages],
  )
  const rows = useMemo(
    () => buildRows(chatMessages, i18n.language),
    [chatMessages, i18n.language],
  )

  const latestUserTitle = useMemo(() => {
    const firstUser = chatMessages.find((m) => m.role === 'user' && m.content.trim())
    if (!firstUser) return t('chat.mobileTitle', { defaultValue: 'agim chat' })
    const compact = firstUser.content.replace(/\s+/g, ' ').trim()
    return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact
  }, [chatMessages, t])

  const latestRuns = useMemo(() => state.runActivities.slice(0, 12), [state.runActivities])
  const activeRun = useMemo(
    () => state.runActivities.find((r) => r.runId === state.activeRunId),
    [state.activeRunId, state.runActivities],
  )

  // Auto-scroll to bottom on new messages OR streaming chunk. Same
  // pinch-tolerance as desktop: hold position when user is reading up.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom > 200 && state.currentReplyId == null) return
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [state.messages, state.currentReplyId])

  // Floating "scroll to bottom" pill.
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

  // Surface WS errors as toast and clear.
  useEffect(() => {
    if (!state.error) return
    if (isNativeSetupError(state.error)) {
      setNativeSetupReason(state.error)
      setNativeSetupDialogOpen(true)
    } else {
      toast.error(state.error)
    }
    clearError()
  }, [state.error, clearError])

  // Auto-grow textarea up to 6 lines.
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
    if (state.currentReplyId) return
    send(v)
    setInput('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // IME-safe: never submit while composition is active.
    const ne = e.nativeEvent as KeyboardEvent & { isComposing?: boolean }
    if (ne.isComposing || e.keyCode === 229) return
    // Mobile keeps Enter for newline; explicit Send button submits.
  }

  function onScrollToBottom(): void {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  function onLogout(): void {
    void fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
      try { localStorage.removeItem('agim_token') } catch { /* noop */ }
      window.location.replace('/login')
    })
  }

  function onStartNewConversation(): void {
    newConversation()
    toast.success(t('chat.newConvToast', { defaultValue: 'Started a new conversation' }))
    setSheet('none')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return (
    <div className="relative flex h-dvh flex-col bg-bg">
      <NativeSetupDialog
        open={nativeSetupDialogOpen}
        reason={nativeSetupReason}
        onOpenChange={setNativeSetupDialogOpen}
        onConfigured={() => switchAgent('agim')}
      />

      <header
        className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
      >
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('chat.back', { defaultValue: 'Back' })}
          onClick={() => (window.history.length > 1 ? window.history.back() : window.location.assign('/'))}
          className="h-9 w-9 p-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col items-center">
          <span className="truncate text-sm font-semibold">{latestUserTitle}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-text-dim">
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', STATUS_STYLES[state.status])} />
              <span>{state.agent ? agentDisplayName(state.agent) : '—'}</span>
            <span>·</span>
            <span>{state.activeRunId ? t('chat.running', { defaultValue: 'Running' }) : statusLabel}</span>
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('chat.menu', { defaultValue: 'Menu' })}
          onClick={() => setSheet('menu')}
          className="h-9 w-9 p-0"
        >
          <MoreVertical className="h-5 w-5" />
        </Button>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-3 py-4">
          {chatMessages.length === 0 && state.status === 'open' && (
            <div className="flex flex-col items-center gap-2 py-14 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-2xl">
                💬
              </div>
              <h2 className="text-base font-semibold">
                {t('chat.welcomeTitle', { defaultValue: 'Start a conversation' })}
              </h2>
              <p className="max-w-xs text-sm text-text-dim">
                {t('chat.welcomeBodyMobile', {
                  defaultValue: 'Type a message below. Switch agent or start over from the menu.',
                })}
              </p>
            </div>
          )}
          {chatMessages.length === 0 && state.status !== 'open' && (
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
          {rows.map((row) => row.type === 'divider' ? (
            <div key={row.key} className="py-1 text-center text-[11px] text-text-muted">
              {row.label}
            </div>
          ) : (
            <div key={row.key} className="space-y-1">
              <MessageBubble
                msg={row.msg}
                onApprove={(mid, reqId, choice) => approvalClick(mid, reqId, choice)}
              />
              <div className={cn(
                'px-1 text-[11px] text-text-muted',
                row.msg.role === 'user' ? 'text-right' : 'text-left',
              )}
              >
                {formatClock(row.msg.timestamp, i18n.language)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {showScrollDown && (
        <button
          type="button"
          onClick={onScrollToBottom}
          className="absolute bottom-28 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-surface p-2 shadow-md"
          aria-label={t('chat.scrollDown', { defaultValue: 'Scroll to bottom' })}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}

      <ApprovalDock
        approvals={state.pendingApprovals}
        onApprove={(mid, reqId, choice) => approvalClick(mid, reqId, choice)}
      />

      <form
        onSubmit={onSubmit}
        className="sticky bottom-0 border-t border-border bg-surface px-3 py-2"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.5rem)' }}
      >
        {chatMessages.length === 0 && state.status === 'open' && (
          <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => {
                  setInput(prompt)
                  requestAnimationFrame(() => inputRef.current?.focus())
                }}
                className="shrink-0 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-dim hover:bg-surface-hover"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        {activeRun && (
          <div className="mb-2 flex items-center justify-between rounded-xl border border-info/30 bg-info-bg/50 px-3 py-1.5">
            <span className="inline-flex items-center gap-1 text-xs text-info">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('chat.running', { defaultValue: 'Running' })}
            </span>
            <span className="truncate text-xs text-text-dim">
              {agentDisplayName(activeRun.agent)} · {formatDurationMs(activeRun.durationMs)}
            </span>
          </div>
        )}

        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onStartNewConversation}
            disabled={state.status !== 'open' || !!state.currentReplyId}
            aria-label={t('chat.newConv', { defaultValue: 'New conversation' })}
            className="h-11 w-11 shrink-0 rounded-full p-0"
          >
            <Sparkles className="h-4 w-4" />
          </Button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('chat.inputPlaceholderMobile', { defaultValue: 'Message…' })}
            rows={1}
            className={cn(
              'flex-1 resize-none rounded-3xl border border-border bg-bg',
              'px-3 py-2 text-[15px] leading-6',
              'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg',
            )}
          />
          <Button
            type="submit"
            disabled={!input.trim() || state.status !== 'open' || !!state.currentReplyId}
            aria-label={t('chat.send', { defaultValue: 'Send' })}
            className="h-11 w-11 shrink-0 rounded-full p-0"
          >
            {state.currentReplyId ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {state.currentReplyId && (
              <Badge variant="info">
                {t('chat.streaming', { defaultValue: '… streaming' })}
              </Badge>
            )}
            {!state.currentReplyId && (
              <span className="text-[11px] text-text-muted">
                {t('chat.mobileHint')}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSheet('activity')}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-text-dim hover:bg-surface-hover hover:text-text"
          >
            <Activity className="h-3.5 w-3.5" />
            {t('chat.activity', { defaultValue: 'Activity' })}
          </button>
        </div>
      </form>

      {sheet !== 'none' && (
        <>
          <button
            type="button"
            aria-label={t('actions.close', { ns: 'common', defaultValue: 'Close' })}
            className="fixed inset-0 z-30 bg-black/35"
            onClick={() => setSheet('none')}
          />
          <div className="fixed inset-x-0 bottom-0 z-40 rounded-t-2xl border border-border bg-surface px-4 pb-safe pt-3 shadow-lg">
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-border" />

            {sheet === 'menu' && (
              <div className="space-y-3 pb-3">
                <div>
                  <div className="mb-1 text-[11px] uppercase text-text-dim">
                    {t('chat.agent', { defaultValue: 'Agent' })}
                  </div>
                  <AgentPicker
                    agents={state.agents}
                    value={state.agent}
                    onChange={(a) => {
                      switchAgent(a)
                      setSheet('none')
                    }}
                  />
                </div>

                <button
                  type="button"
                  className="block w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50"
                  disabled={state.status !== 'open' || !!state.currentReplyId}
                  onClick={onStartNewConversation}
                >
                  {t('chat.newConv', { defaultValue: 'New conversation' })}
                </button>

                <button
                  type="button"
                  className="block w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-surface-hover"
                  onClick={() => setSheet('activity')}
                >
                  {t('chat.activity', { defaultValue: 'Activity' })}
                </button>

                <button
                  type="button"
                  className="block w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-surface-hover"
                  onClick={() => {
                    setSheet('none')
                    window.location.assign('/settings/llm')
                  }}
                >
                  {t('chat.llmSettings', { defaultValue: 'LLM settings' })}
                </button>

                <button
                  type="button"
                  className="block w-full rounded-md border border-danger/30 px-3 py-2 text-left text-sm text-danger hover:bg-danger/10"
                  onClick={onLogout}
                >
                  {t('chat.logout', { defaultValue: 'Log out' })}
                </button>
              </div>
            )}

            {sheet === 'activity' && (
              <div className="space-y-3 pb-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">
                    {t('chat.activityTitle', { defaultValue: 'Run activity' })}
                  </div>
                  <button
                    type="button"
                    className="text-xs text-text-dim hover:text-text"
                    onClick={() => setSheet('menu')}
                  >
                    {t('actions.back', { ns: 'common', defaultValue: 'Back' })}
                  </button>
                </div>

                <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text-dim">
                  {t('chat.pendingApprovals', { defaultValue: 'Pending approvals' })}: {state.pendingApprovals.length}
                </div>

                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {latestRuns.length === 0 && (
                    <div className="rounded-md border border-border px-3 py-5 text-center text-xs text-text-dim">
                      {t('chat.activityEmpty', { defaultValue: 'No recent runs yet.' })}
                    </div>
                  )}
                  {latestRuns.map((run) => (
                    <div key={run.runId} className="rounded-md border border-border px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Badge className={cn('border-0', runStatusBadgeClass(run.status))}>
                          {run.status}
                        </Badge>
                        <span className="truncate text-xs font-medium">{agentDisplayName(run.agent)}</span>
                        <span className="ml-auto text-[11px] text-text-muted">
                          {formatDurationMs(run.durationMs)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-text-muted">
                        <Clock3 className="h-3 w-3" />
                        {formatClock(run.startedAt, i18n.language)}
                        {run.outputChars != null && (
                          <span>· {run.outputChars} chars</span>
                        )}
                      </div>
                      {run.error && (
                        <p className="mt-1 text-[11px] text-danger">{run.error}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
