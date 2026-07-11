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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  MessageSquare,
  MessageSquarePlus,
  Plug,
  Send,
  Settings,
} from 'lucide-react'
import { toast } from 'sonner'

import { useChat } from '@/hooks/use-chat'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MessageBubble } from '@/components/chat/message-bubble'
import { ApprovalDock } from '@/components/chat/approval-dock'
import { AskDock } from '@/components/chat/ask-dock'
import { AgentPicker } from '@/components/chat/agent-picker'
import { isNativeSetupError } from '@/components/chat/error-hints'
import { NativeSetupDialog } from '@/components/chat/native-setup-dialog'
import { Topbar } from '@/components/shell/topbar'
import { agentDisplayName } from '@/lib/agent-label'
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
    state, send, switchAgent, approvalClick, choiceSubmit, newConversation, clearError,
  } = useChat()
  const [input, setInput] = useState('')
  const [nativeSetupDialogOpen, setNativeSetupDialogOpen] = useState(false)
  const [nativeSetupReason, setNativeSetupReason] = useState('')
  const [searchParams] = useSearchParams()
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const statusLabel = t(`chat.status.${state.status}`, { defaultValue: state.status })
  const messageCount = state.messages.length
  const latestMessageContent = state.messages.at(-1)?.content ?? ''
  const forceWelcome = searchParams.get('welcome') === '1'
    || searchParams.get('onboarding') === '1'
  const quickPrompts = useMemo(
    () => [
      t('chat.quickPrompt.plan'),
      t('chat.quickPrompt.risks'),
      t('chat.quickPrompt.summary'),
    ],
    [t],
  )

  // Auto-scroll to bottom on new messages OR streaming chunk. Use
  // requestAnimationFrame so the layout has settled before we scroll;
  // also tolerate the case where the user scrolled up intentionally.
  useEffect(() => {
    if (messageCount === 0 && !latestMessageContent && state.currentReplyId == null) return
    if (!listRef.current) return
    const el = listRef.current
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (!nearBottom && state.currentReplyId == null) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [latestMessageContent, messageCount, state.currentReplyId])

  // Surface WS errors as toasts (and clear so they don't re-fire on
  // every render).
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
          title={statusLabel}
        />
        <span className="hidden text-xs text-text-dim sm:inline">{statusLabel}</span>
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

      <NativeSetupDialog
        open={nativeSetupDialogOpen}
        reason={nativeSetupReason}
        onOpenChange={setNativeSetupDialogOpen}
        onConfigured={() => switchAgent('agim')}
      />

      {/* Message list */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-3 py-3 sm:px-4">
          {(state.messages.length === 0 || forceWelcome) && state.status === 'open' && (
            <FirstRunPanel
              agent={state.agent}
              agents={state.agents}
              prompts={quickPrompts}
              onPickPrompt={(prompt) => {
                setInput(prompt)
                requestAnimationFrame(() => inputRef.current?.focus())
              }}
            />
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
          {state.messages
            // v1.2.115 — approval cards now render in the dock, not
            // inline. Filter out any approval-typed messages that may
            // exist in restored history from older builds (server-side
            // session may still hold them as system rows).
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

      {/* v1.2.115 — floating approval dock pinned above the input.
          Renders only when there are pending cards. */}
      <ApprovalDock
        approvals={state.pendingApprovals}
        onApprove={(mid, reqId, choice) => approvalClick(mid, reqId, choice)}
      />

      {/* ask_user (choice) dock — same placement/lifecycle as approvals. */}
      <AskDock
        asks={state.pendingAsks}
        onSubmit={(mid, data) => choiceSubmit(mid, data)}
      />

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

interface FirstRunPanelProps {
  agent: string
  agents: string[]
  prompts: string[]
  onPickPrompt: (prompt: string) => void
}

function FirstRunPanel({
  agent,
  agents,
  prompts,
  onPickPrompt,
}: FirstRunPanelProps): JSX.Element {
  const { t } = useTranslation()
  const activeAgent = agent ? agentDisplayName(agent) : t('chat.onboarding.agentPending', {
    defaultValue: 'Loading agent…',
  })
  const agentCount = agents.length

  return (
    <section className="mx-auto my-8 w-full max-w-2xl rounded-md border border-border bg-surface px-4 py-4 text-left shadow-sm sm:my-12 sm:px-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-2 text-accent">
          <MessageSquare className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-text">
              {t('chat.onboarding.title', { defaultValue: 'Get one chat working first' })}
            </h2>
            <Badge variant="success">
              {t('chat.onboarding.readyBadge', { defaultValue: 'Web ready' })}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-text-dim">
            {t('chat.onboarding.body', {
              defaultValue: 'Current agent: {{agent}}',
              agent: activeAgent,
            })}
          </p>

          <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <OnboardingStep
              icon={<CheckCircle2 />}
              label={t('chat.onboarding.stepWeb', { defaultValue: 'Web console connected' })}
              tone="success"
            />
            <OnboardingStep
              icon={<Bot />}
              label={t('chat.onboarding.stepAgent', {
                defaultValue: 'Agent selected: {{agent}}',
                agent: activeAgent,
              })}
              meta={agentCount > 1
                ? t('chat.onboarding.agentCount', {
                    defaultValue: '{{count}} available',
                    count: agentCount,
                  })
                : undefined}
            />
            <OnboardingStep
              icon={<Send />}
              label={t('chat.onboarding.stepMessage', {
                defaultValue: 'Send the first message',
              })}
            />
            <OnboardingStep
              icon={<Plug />}
              label={t('chat.onboarding.stepMessenger', {
                defaultValue: 'Connect IM after chat works',
              })}
            />
          </div>

          <div className="mt-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {prompts.map((prompt) => (
                <Button
                  key={prompt}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="max-w-full"
                  onClick={() => onPickPrompt(prompt)}
                >
                  <Send className="h-4 w-4" />
                  <span className="min-w-0 truncate">{prompt}</span>
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link to="/settings/llm">
                  <Settings className="h-4 w-4" />
                  <span>{t('chat.onboarding.agentSettings', { defaultValue: 'Agent settings' })}</span>
                </Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link to="/settings/messengers">
                  <Plug className="h-4 w-4" />
                  <span>{t('chat.onboarding.messengerSettings', { defaultValue: 'Connect IM' })}</span>
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

interface OnboardingStepProps {
  icon: React.ReactNode
  label: string
  meta?: string
  tone?: 'success' | 'muted'
}

function OnboardingStep({
  icon,
  label,
  meta,
  tone = 'muted',
}: OnboardingStepProps): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2',
          tone === 'success' ? 'text-success' : 'text-text-dim',
          '[&_svg]:h-4 [&_svg]:w-4',
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm text-text">{label}</span>
        {meta && <span className="block truncate text-xs text-text-muted">{meta}</span>}
      </span>
    </div>
  )
}
