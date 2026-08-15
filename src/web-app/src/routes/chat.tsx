/**
 * /chat — agim's primary surface. Replaces the PR-5 placeholder.
 *
 * Layout: sticky topbar (agent picker + status dot + theme/lang) +
 * scrollable message list + bottom composer lifted by visualViewport
 * when the soft keyboard is open (iOS Safari).
 *
 * State: useChat() owns the WebSocket + reducer; the route is a
 * thin presenter — every interaction (send, switch-agent, approval
 * click) calls through. Theme + language come from the shell's
 * usePrefs store; lib/api/errors.ts handles the toast.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
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
import { useComposerEnterNewline } from '@/hooks/use-composer-enter-newline'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useChatFollowBottom, useChatKeyboardAnchor } from '@/hooks/use-chat-scroll'
import { ChatJumpToLatest } from '@/components/chat/chat-jump-to-latest'
import { blurComposerOnListInteract, useBlurComposerOnUserScroll } from '@/hooks/use-blur-composer'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MessageBubble } from '@/components/chat/message-bubble'
import { bubbleGroupFlags } from '@/components/chat/bubble-group'
import { ChatComposer } from '@/components/chat/chat-composer'
import { PortalSteerQueue, type PendingSendItem } from '@/components/m-portal/portal-steer-queue'
import { ComposerStatusBar } from '@/components/chat/composer-status-bar'
import { LlmSettingsDialog } from '@/components/chat/llm-settings-dialog'
import { ChatActivityBlock } from '@/components/chat/chat-activity-block'
import { ApprovalDock } from '@/components/chat/approval-dock'
import { activityFollowSignal } from '@/lib/activity-follow-signal'

/** Keep the Todo card out of the SPA entry budget (same pattern as MessageActions). */
const ChatTodoList = lazy(async () => {
  const module = await import('@/components/chat/chat-todo-list')
  return { default: module.ChatTodoList }
})
/** Subagent card + detail dialog — sibling of Plan in the message list. */
const ChatSubagentCard = lazy(async () => {
  const module = await import('@/components/chat/chat-subagent-card')
  return { default: module.ChatSubagentCard }
})
/** Native setup pulls llm-presets + select-heavy form UI — keep out of entry. */
const NativeSetupDialog = lazy(async () => {
  const module = await import('@/components/chat/native-setup-dialog')
  return { default: module.NativeSetupDialog }
})
const PortalScheduledLoopDock = lazy(async () => {
  const module = await import('@/components/m-portal/portal-scheduled-loop-dock')
  return { default: module.PortalScheduledLoopDock }
})
import { AskDock } from '@/components/chat/ask-dock'
import { AgentPicker } from '@/components/chat/agent-picker'
import { isNativeSetupError } from '@/components/chat/error-hints'
import { useComposerModelStatus } from '@/hooks/use-composer-model-status'
import { useOnboardingStatus } from '@/hooks/use-onboarding'
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
    state, send, steer, stopSubagent, switchAgent, approvalClick, choiceSubmit, newConversation, clearError,
  } = useChat()
  const [input, setInput] = useState('')
  const [pendingSends, setPendingSends] = useState<PendingSendItem[]>([])
  const [queueThreadId, setQueueThreadId] = useState(state.clientId)
  const [nativeSetupDialogOpen, setNativeSetupDialogOpen] = useState(false)
  const [nativeSetupReason, setNativeSetupReason] = useState('')
  const [llmSettingsOpen, setLlmSettingsOpen] = useState(false)
  const [optimisticThink, setOptimisticThink] = useState<string | null>(null)
  const [thinkBaseline, setThinkBaseline] = useState(state.thinkVariant)
  const [optimisticStepReflect, setOptimisticStepReflect] = useState<boolean | null>(null)
  const [stepReflectBaseline, setStepReflectBaseline] = useState(state.stepReflect)
  const modelStatus = useComposerModelStatus(state.agent, state.messages, state.sessionModel)
  const thinkVariant = optimisticThink ?? state.thinkVariant
  const stepReflect = optimisticStepReflect ?? state.stepReflect
  const [optimisticModel, setOptimisticModel] = useState<string | null>(null)
  const [modelBaseline, setModelBaseline] = useState(state.sessionModel)
  const [optimisticCompactRate, setOptimisticCompactRate] = useState<string | null>(null)
  const [compactRateBaseline, setCompactRateBaseline] = useState(state.compactRate)
  const compactRate = optimisticCompactRate ?? state.compactRate
  const [searchParams] = useSearchParams()
  const onboarding = useOnboardingStatus()
  // Clear optimistic overrides when the server session catches up (render-time sync).
  if (state.thinkVariant !== thinkBaseline) {
    setThinkBaseline(state.thinkVariant)
    setOptimisticThink(null)
  }
  if (state.stepReflect !== stepReflectBaseline) {
    setStepReflectBaseline(state.stepReflect)
    setOptimisticStepReflect(null)
  }
  if (state.sessionModel !== modelBaseline) {
    setModelBaseline(state.sessionModel)
    setOptimisticModel(null)
  }
  if (state.compactRate !== compactRateBaseline) {
    setCompactRateBaseline(state.compactRate)
    setOptimisticCompactRate(null)
  }
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const keyboardInset = useKeyboardInset()
  const enterNewline = useComposerEnterNewline()
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

  const visibleMessages = useMemo(
    () => state.messages.filter((m) => !m.approval),
    [state.messages],
  )

  const latestFollowSignal = activityFollowSignal(state.messages.at(-1)?.activity)
  const { stickToBottom, showJumpToLatest } = useChatFollowBottom({
    listRef,
    messageCount,
    latestMessageContent,
    streaming: state.currentReplyId != null,
    followSignal: latestFollowSignal,
    threadKey: state.clientId,
  })
  useChatKeyboardAnchor({ listRef, inputRef, keyboardInset })
  useBlurComposerOnUserScroll(listRef, inputRef)

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

  const busy = state.currentReplyId != null || state.activeRunId != null
  const canSteerLive = busy && (state.agent === 'agim' || state.agent === 'native')
  if (state.clientId !== queueThreadId) {
    setQueueThreadId(state.clientId)
    setPendingSends([])
  }

  useEffect(() => {
    if (busy) return
    const ready = pendingSends.filter((item) => item.flushAfter)
    if (ready.length === 0) return
    setPendingSends((cur) => cur.filter((item) => !item.flushAfter))
    for (const item of ready) send(item.text)
  }, [busy, pendingSends, send])

  function onSubmit(): void {
    const v = input.trim()
    if (!v) return
    if (state.status !== 'open') {
      toast.error(t('chat.notConnected', { defaultValue: 'Not connected. Reconnecting…' }))
      return
    }
    stickToBottom()
    setInput('')
    if (busy) {
      setPendingSends((cur) => [
        ...cur,
        { id: `q-${Date.now()}-${cur.length}`, text: v },
      ])
      return
    }
    send(v)
  }

  function dismissPending(id: string): void {
    setPendingSends((cur) => cur.filter((item) => item.id !== id))
  }

  function reeditPending(id: string): void {
    const item = pendingSends.find((row) => row.id === id)
    if (!item) return
    const draft = input.trim()
    setPendingSends((cur) => {
      const next = cur.filter((row) => row.id !== id)
      if (!draft) return next
      return [...next, { id: `q-${Date.now()}-${next.length}`, text: draft }]
    })
    setInput(item.text)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function flushPending(id: string): void {
    const item = pendingSends.find((row) => row.id === id)
    if (!item || item.flushAfter) return
    if (canSteerLive) {
      setPendingSends((cur) => cur.filter((row) => row.id !== id))
      steer(item.text)
      return
    }
    if (busy) {
      setPendingSends((cur) => cur.map((row) => (
        row.id === id ? { ...row, flushAfter: true } : row
      )))
      return
    }
    setPendingSends((cur) => cur.filter((row) => row.id !== id))
    send(item.text)
  }

  if (onboarding.data?.firstRun && !forceWelcome) {
    return <Navigate to="/setup" replace />
  }

  return (
    <div
      className="relative flex h-dvh flex-col bg-bg"
      data-agim-composer-sheet-root
      data-agim-sheet-column="chat"
    >
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

      <LlmSettingsDialog
        open={llmSettingsOpen}
        onOpenChange={setLlmSettingsOpen}
      />
      {nativeSetupDialogOpen ? (
        <Suspense fallback={null}>
          <NativeSetupDialog
            open={nativeSetupDialogOpen}
            reason={nativeSetupReason}
            onOpenChange={setNativeSetupDialogOpen}
            onConfigured={() => switchAgent('agim')}
          />
        </Suspense>
      ) : null}

      {/* Message list */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto overscroll-contain"
        onPointerDown={(e) => blurComposerOnListInteract(e, inputRef)}
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
          {visibleMessages.map((m, i) => {
            const flags = bubbleGroupFlags(visibleMessages, i)
            return (
              <div key={m.id} className="space-y-1">
                {m.role === 'assistant' && m.activity && (
                  <ChatActivityBlock activity={m.activity} />
                )}
                {/* Plan first, then Subagents — Plan is the turn outline and
                    should stay above nested work when both are present. */}
                {m.role === 'assistant' && m.activity && (
                  <Suspense fallback={null}>
                    <ChatTodoList activity={m.activity} />
                  </Suspense>
                )}
                {m.role === 'assistant' && m.activity && (
                  <Suspense fallback={null}>
                    <ChatSubagentCard
                      activity={m.activity}
                      onStopSubagent={stopSubagent}
                      stepReflectEnabled={stepReflect}
                    />
                  </Suspense>
                )}
                <MessageBubble
                  msg={m}
                  isFirstInGroup={flags.isFirstInGroup}
                  isLastInGroup={flags.isLastInGroup}
                  onApprove={(mid, reqId, choice) => approvalClick(mid, reqId, choice)}
                  threadId={state.clientId || undefined}
                  onDownvotePrefill={() => {
                    setInput(t('chat.portal.feedbackPrefill'))
                    requestAnimationFrame(() => inputRef.current?.focus())
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>

      <Suspense fallback={null}>
        <PortalScheduledLoopDock threadId={state.clientId} />
      </Suspense>

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

      <div className="relative">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-0 justify-center">
          <ChatJumpToLatest
            show={showJumpToLatest}
            onJump={stickToBottom}
            className="pointer-events-auto -translate-y-[calc(100%+0.5rem)]"
          />
        </div>
      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={onSubmit}
        disabled={state.status !== 'open'}
        busy={busy}
        allowBusySubmit
        prepend={(
          <PortalSteerQueue
            dark={false}
            items={pendingSends}
            onSend={flushPending}
            onDismiss={dismissPending}
            onReedit={reeditPending}
          />
        )}
        enterNewline={enterNewline}
        keyboardInset={keyboardInset}
        inputRef={inputRef}
        placeholder={t(
          enterNewline ? 'chat.inputPlaceholderMobile' : 'chat.inputPlaceholder',
          {
            defaultValue: enterNewline
              ? 'Message…'
              : 'Message… (Enter sends, Ctrl/⌘+Enter newlines)',
          },
        )}
        footer={(
          <div className="space-y-1.5">
            {enterNewline ? (
              <p className="text-xs text-text-muted">
                {t('chat.mobileHint', {
                  defaultValue: 'Enter creates new lines; tap Send to submit.',
                })}
              </p>
            ) : null}
            {state.currentReplyId ? (
              <Badge variant="info">
                {t('chat.streaming', { defaultValue: '… streaming' })}
              </Badge>
            ) : null}
            <ComposerStatusBar
              modelLabel={
                optimisticModel
                  ? (modelStatus.modelOptions.find((o) => o.backendName === optimisticModel)?.model
                    ?? modelStatus.modelLabel)
                  : modelStatus.modelLabel
              }
              modelMissing={modelStatus.modelMissing}
              modelOptions={modelStatus.modelOptions}
              activeBackendName={optimisticModel ?? modelStatus.activeBackendName}
              thinkVariant={thinkVariant}
              showThinking={modelStatus.showThinking}
              contextUsed={modelStatus.contextUsed}
              contextWindow={modelStatus.contextWindow}
              breakdown={modelStatus.breakdown}
              compactRate={compactRate}
              disabled={state.status !== 'open'}
              onConfigureModel={() => setLlmSettingsOpen(true)}
              onSelectModel={(backendName) => {
                if (state.status !== 'open') {
                  toast.error(t('chat.notConnected', { defaultValue: 'Not connected. Reconnecting…' }))
                  return
                }
                setOptimisticModel(backendName)
                send(`/model ${backendName}`)
              }}
              onSendCommand={(cmd) => {
                if (state.status !== 'open') {
                  toast.error(t('chat.notConnected', { defaultValue: 'Not connected. Reconnecting…' }))
                  return
                }
                if (cmd.startsWith('/think')) {
                  const level = cmd.replace(/^\/think\s*/, '').trim() || 'auto'
                  setOptimisticThink(level)
                }
                if (cmd.startsWith('/step-reflect')) {
                  const token = cmd.replace(/^\/step-reflect\s*/, '').trim()
                  setOptimisticStepReflect(token !== 'off')
                }
                if (cmd.startsWith('/ctx')) {
                  const rate = cmd.replace(/^\/ctx\s*/, '').trim() || 'auto'
                  setOptimisticCompactRate(rate)
                }
                send(cmd)
              }}
            />
          </div>
        )}
      />
      </div>
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
