/**
 * Agent Portal — chat surface for `/m/chat` (also used by iOS/macOS shells).
 *
 * Layout:
 *   - below lg: single column + overlay drawer (hamburger)
 *   - lg+: Cursor-like shell — persistent left rail + centered chat column
 *     (max 750px) so side gutters stay free for future panels.
 *
 * Transport: existing useChat() WebSocket.
 */

import {
  lazy, Suspense,
  useCallback, useEffect, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Mic, Square } from 'lucide-react'
import { toast } from 'sonner'

import { useChat } from '@/hooks/use-chat'
import { useWebWorkspaces } from '@/hooks/use-web-workspaces'
import { useChatFollowBottom } from '@/hooks/use-chat-scroll'
import { ChatJumpToLatest } from '@/components/chat/chat-jump-to-latest'
import { api } from '@/lib/api/endpoints'
import { findSession, upsertSession } from '@/lib/web-sessions'
import {
  addLocalWorkspace,
  findWorkspace,
  setActiveWorkspace,
  toggleWorkspaceCollapsed,
} from '@/lib/web-workspaces'
import { useComposerEnterNewline } from '@/hooks/use-composer-enter-newline'
import { useComposerModelStatus } from '@/hooks/use-composer-model-status'
import { shouldSubmitOnEnterKey } from '@/lib/composer-enter'
import { isNativeSetupError } from '@/components/chat/error-hints'
import { ComposerStatusBar } from '@/components/chat/composer-status-bar'
import { LlmSettingsDialog } from '@/components/chat/llm-settings-dialog'
import { NativeSetupDialog } from '@/components/chat/native-setup-dialog'
import { useIosViewportZoomReset } from '@/hooks/use-ios-viewport-zoom-reset'
import { usePortalViewportFrame } from '@/hooks/use-portal-viewport-frame'
import { ApprovalDock } from '@/components/chat/approval-dock'
import { AskDock } from '@/components/chat/ask-dock'
import { activityFollowSignal } from '@/lib/activity-follow-signal'

const PortalLoopDock = lazy(async () => {
  const module = await import('./portal-loop-dock')
  return { default: module.PortalLoopDock }
})
import { usePrefs, type Lang } from '@/stores/prefs'
import { cn } from '@/lib/utils'
import { agentVisual, displayAgentName } from './agent-visuals'
import {
  AttachmentStrip,
  PortalComposerPlus,
  uploadPendingAttachments,
  type PendingAttachment,
} from './portal-composer-plus'
import {
  chipsFromValue,
  makeChip,
  PortalComposerInput,
  serializeComposer,
} from './portal-composer-input'
import {
  bumpSkillUsage,
  bumpSlashUsage,
  detectAtTrigger,
  detectSlashTrigger,
  PortalAtPopup,
  PortalSlashPopup,
} from './portal-composer-menus'
import { mentionLabel } from './portal-mention-chip'
import {
  collapseDemoMessages,
  jumpLatestDemoMessages,
  mediaDemoMessages,
  petDemoMessages,
  todoDemoMessages,
  widthDemoMessages,
} from './portal-demo-fixtures'
import { PortalSidePanel } from './portal-side-panel'
import { PortalSteerQueue, type PendingSendItem } from './portal-steer-queue'
import { PortalWorkspacePicker } from './portal-workspace-picker'
import { PortalPet } from './portal-pet'
import {
  skillMarker,
  workspaceFileMarker,
  workspaceMarker,
  type PortalSkillItem,
  type PortalSlashCommand,
} from './portal-slash-commands'
import { VoiceInputOverlay } from './voice-input-overlay'
import { groupChatTurns } from './portal-chat-turns'
import { resolveTheme, type Theme } from './portal-theme'
import { usePortalVoice } from './use-portal-voice'
import { usePortalPetTasks } from './use-portal-pet-tasks'
import { PortalHeader, type AgentCatalogEntry } from './portal-header'
import { PortalEmptyChat } from './portal-empty-chat'
import { PortalMessageList } from './portal-message-list'
import { PortalExplore, type ExploreCategory } from './portal-explore'

type Tab = 'chat' | 'explore'

export function AgentPortal(): JSX.Element {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const theme = resolveTheme(prefs.theme)
  const setTheme = (next: Theme): void => {
    prefs.setTheme(next)
  }
  const toggleLang = (): void => {
    const next: Lang = prefs.lang === 'zh' ? 'en' : 'zh'
    prefs.setLang(next)
  }

  const {
    state, send, steer, stop, stopSubagent, switchAgent, approvalClick, choiceSubmit,
    newConversation, switchSession, syncWorkspace, sessions, activeSessionId, clearError,
  } = useChat()
  const {
    workspaces,
    activeId: activeWorkspaceId,
    collapsed: collapsedWorkspaces,
  } = useWebWorkspaces()
  useIosViewportZoomReset()
  const { style: viewportStyle } = usePortalViewportFrame()
  const [activeTab, setActiveTab] = useState<Tab>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [nativeSetupDialogOpen, setNativeSetupDialogOpen] = useState(false)
  const [nativeSetupReason, setNativeSetupReason] = useState('')
  const [llmSettingsOpen, setLlmSettingsOpen] = useState(false)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [optimisticThink, setOptimisticThink] = useState<string | null>(null)
  const [thinkBaseline, setThinkBaseline] = useState(state.thinkVariant)
  const modelStatus = useComposerModelStatus(state.agent, state.messages, state.sessionModel)
  const thinkVariant = optimisticThink ?? state.thinkVariant
  const [optimisticModel, setOptimisticModel] = useState<string | null>(null)
  const [modelBaseline, setModelBaseline] = useState(state.sessionModel)
  const [optimisticCompactRate, setOptimisticCompactRate] = useState<string | null>(null)
  const [compactRateBaseline, setCompactRateBaseline] = useState(state.compactRate)
  const compactRate = optimisticCompactRate ?? state.compactRate
  // Clear optimistic overrides when the server session catches up (render-time sync).
  if (state.thinkVariant !== thinkBaseline) {
    setThinkBaseline(state.thinkVariant)
    setOptimisticThink(null)
  }
  if (state.sessionModel !== modelBaseline) {
    setModelBaseline(state.sessionModel)
    setOptimisticModel(null)
  }
  if (state.compactRate !== compactRateBaseline) {
    setCompactRateBaseline(state.compactRate)
    setOptimisticCompactRate(null)
  }
  // Persist the left rail on large screens (Cursor-like); drawer only below lg.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const sync = (): void => {
      if (mq.matches) setSidebarOpen(false)
    }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Agim Agent missing LLM → same one-click DeepSeek dialog as desktop `/`.
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

  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [exploreCategory, setExploreCategory] = useState<ExploreCategory>('All')
  const [inputMessage, setInputMessage] = useState('')
  const [pendingSends, setPendingSends] = useState<PendingSendItem[]>([])
  const [queueThreadId, setQueueThreadId] = useState(state.clientId)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const enterNewline = useComposerEnterNewline()
  const [slashOpen, setSlashOpen] = useState(false)
  const [atOpen, setAtOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [atQuery, setAtQuery] = useState('')
  const [slashActive, setSlashActive] = useState(0)
  const [atActive, setAtActive] = useState(0)
  const [slashTriggerStart, setSlashTriggerStart] = useState(0)
  const [atTriggerStart, setAtTriggerStart] = useState(0)
  const messagesListRef = useRef<HTMLDivElement>(null)
  const composerFormRef = useRef<HTMLFormElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  /** Caret for /@ commit — ref so typing does not re-render the portal. */
  const textCaretRef = useRef(0)
  const slashQueryRef = useRef('')
  const atQueryRef = useRef('')
  const slashOpenRef = useRef(false)
  const atOpenRef = useRef(false)
  const slashTriggerStartRef = useRef(0)
  const atTriggerStartRef = useRef(0)
  // Stable callbacks for memo(PortalMessageList / PortalLoopDock) across keystrokes.
  const stopSubagentRef = useRef(stopSubagent)
  stopSubagentRef.current = stopSubagent
  const sendRef = useRef(send)
  sendRef.current = send
  const onStopSubagent = useCallback((jobId: number) => stopSubagentRef.current(jobId), [])
  const onLoopSend = useCallback((text: string) => {
    if (state.status !== 'open') {
      toast.error('Not connected')
      return
    }
    sendRef.current(text)
  }, [state.status])
  const onFillPrompt = useCallback((p: string) => {
    setInputMessage(p)
  }, [])

  const agentId = state.agent || state.agents[0] || 'agim'
  const visual = useMemo(() => agentVisual(agentId), [agentId])
  const AgentIcon = visual.icon
  const isTyping = state.currentReplyId != null
  const demoWidth = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === 'width'
  const demoPet = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === 'pet'
  const demoTodo = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === 'todo'
  const demoMedia = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === 'media'
  const demoCollapse = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === 'collapse'
  const demoSteer = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === 'steer-queue'
  const demoJump = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === 'jump-latest'
  const chatMessages = useMemo(
    () => {
      if (demoSteer || demoPet) return petDemoMessages()
      if (demoJump) return jumpLatestDemoMessages()
      if (demoTodo) return todoDemoMessages()
      if (demoWidth) return widthDemoMessages()
      if (demoCollapse) return collapseDemoMessages()
      if (demoMedia) {
        const params = new URLSearchParams(window.location.search)
        const images = (params.get('images') || '').split('|').filter(Boolean)
        const file = params.get('file') || ''
        const fileName = params.get('fileName') || 'notes.txt'
        if (images.length > 0 && file) {
          return mediaDemoMessages(images, file, fileName)
        }
      }
      return state.messages.filter((m) => !m.approval)
    },
    [demoSteer, demoJump, demoTodo, demoPet, demoWidth, demoCollapse, demoMedia, state.messages],
  )
  const chatTurns = useMemo(() => groupChatTurns(chatMessages), [chatMessages])
  const currentReplyInList = chatMessages.some((m) => m.id === state.currentReplyId)
  // Fallback only when the placeholder message has not landed yet.
  const streamingFallback = isTyping && !currentReplyInList
  const liveBusy = isTyping || state.activeRunId != null
  const canStop = liveBusy || demoSteer
  const canSteerLive = liveBusy && (agentId === 'agim' || agentId === 'native')
  if (state.clientId !== queueThreadId) {
    setQueueThreadId(state.clientId)
    setPendingSends([])
  }

  useEffect(() => {
    if (canStop) return
    const ready = pendingSends.filter((item) => item.flushAfter)
    if (ready.length === 0) return
    setPendingSends((cur) => cur.filter((item) => !item.flushAfter))
    for (const item of ready) send(item.text)
  }, [canStop, pendingSends, send])

  const portalThreadId = state.clientId
  // Include WS status + activeRunId so reconnect / new run re-polls Loop
  // even when messages.length stays flat (in-place chunk updates).
  const loopRefreshKey = `${state.messages.length}:${canStop ? 1 : 0}:${state.activeRunId ?? ''}:${state.status}`
  const hasBlockingDock = state.pendingApprovals.some((a) => !a.outcome)
    || state.pendingAsks.some((a) => !a.finalText)

  const { petTasks, petAnnounce, setPetAnnounce, threadBgjobs } = usePortalPetTasks({
    chatMessages,
    isTyping,
    currentReplyId: state.currentReplyId,
    agentId,
    pendingApprovals: state.pendingApprovals,
    pendingAsks: state.pendingAsks,
    portalThreadId,
    demoPet,
  })

  // Lock document scroll so WKWebView / mobile Safari rubber-band the
  // message list only — not the whole portal chrome.
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('agim-portal-lock')
    return () => {
      root.classList.remove('agim-portal-lock')
    }
  }, [])

  // Follow the bottom only while the user is near it. Scrolling up to
  // read history pauses follow so streaming / tool steps do not yank
  // the viewport back down.
  const { stickToBottom, showJumpToLatest } = useChatFollowBottom({
    listRef: messagesListRef,
    messageCount: chatMessages.length,
    latestMessageContent: chatMessages[chatMessages.length - 1]?.content ?? '',
    streaming: isTyping,
    followSignal: activityFollowSignal(chatMessages[chatMessages.length - 1]?.activity),
    threadKey: state.clientId,
  })

  const agentsCatalog = useMemo((): AgentCatalogEntry[] => {
    return state.agents.map((id) => {
      const v = agentVisual(id)
      return {
        id,
        name: displayAgentName(id),
        tagline: v.tagline,
        color: v.color,
        icon: v.icon,
        category: v.category,
      }
    })
  }, [state.agents])

  const filteredAgents = agentsCatalog.filter((a) => {
    const q = searchQuery.toLowerCase()
    const matchesSearch = !q
      || a.name.toLowerCase().includes(q)
      || a.tagline.toLowerCase().includes(q)
      || a.id.toLowerCase().includes(q)
    const matchesCategory = exploreCategory === 'All' || a.category === exploreCategory
    return matchesSearch && matchesCategory
  })

  async function onSend(e?: FormEvent): Promise<void> {
    e?.preventDefault()
    const text = inputMessage.trim()
    if ((!text && attachments.length === 0) || uploading) return
    if (state.status !== 'open') {
      toast.error('Not connected')
      return
    }
    try {
      setUploading(true)
      let markers: string[] = []
      if (attachments.length > 0) {
        const threadId = state.clientId || 'web'
        markers = await uploadPendingAttachments(attachments, threadId)
      }
      const body = [...markers, text].filter(Boolean).join('\n')
      for (const a of attachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      }
      setAttachments([])
      setInputMessage('')
      setSlashOpen(false)
      setAtOpen(false)
      stickToBottom()
      if (canStop) {
        setPendingSends((cur) => [
          ...cur,
          { id: `q-${Date.now()}-${cur.length}`, text: body },
        ])
        return
      }
      send(body)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('chat.portal.attach.uploadFailed', {
        defaultValue: '附件上传失败',
      }))
    } finally {
      setUploading(false)
    }
  }

  function dismissPending(id: string): void {
    setPendingSends((cur) => cur.filter((item) => item.id !== id))
  }

  function flushPending(id: string): void {
    const item = pendingSends.find((row) => row.id === id)
    if (!item || item.flushAfter) return
    if (demoSteer && !liveBusy) {
      setPendingSends((cur) => cur.filter((row) => row.id !== id))
      return
    }
    if (canSteerLive) {
      setPendingSends((cur) => cur.filter((row) => row.id !== id))
      steer(item.text)
      return
    }
    if (canStop) {
      setPendingSends((cur) => cur.map((row) => (
        row.id === id ? { ...row, flushAfter: true } : row
      )))
      return
    }
    setPendingSends((cur) => cur.filter((row) => row.id !== id))
    send(item.text)
  }

  const handleTranscribed = useCallback((transcribedText: string) => {
    setInputMessage((prev) => {
      const { chips, text: plain } = chipsFromValue(prev)
      const nextPlain = plain.trim() ? `${plain.trim()} ${transcribedText}` : transcribedText
      return serializeComposer(chips, nextPlain)
    })
    requestAnimationFrame(() => {
      const ta = composerInputRef.current
      if (!ta) return
      ta.focus()
      const end = ta.value.length
      ta.setSelectionRange(end, end)
    })
  }, [])

  const { voicePhase, voiceLevel, onVoicePointerDown, onVoicePointerMove, onVoicePointerUp } = usePortalVoice({
    canStop,
    uploading,
    lang: prefs.lang,
    connectionStatus: state.status,
    onTranscribed: handleTranscribed,
  })

  const syncTriggers = useCallback((caret: number, plainText: string) => {
    textCaretRef.current = caret
    const slash = detectSlashTrigger(plainText, caret)
    const at = !slash ? detectAtTrigger(plainText, caret) : null
    if (slash) {
      const queryChanged = slashQueryRef.current !== slash.query
      const wasClosed = !slashOpenRef.current
      const startChanged = slashTriggerStartRef.current !== slash.start
      const atWasOpen = atOpenRef.current
      slashQueryRef.current = slash.query
      slashOpenRef.current = true
      atOpenRef.current = false
      slashTriggerStartRef.current = slash.start
      if (wasClosed) setSlashOpen(true)
      if (atWasOpen) setAtOpen(false)
      if (wasClosed || queryChanged) {
        setSlashQuery(slash.query)
        setSlashActive(0)
      }
      if (wasClosed || startChanged) setSlashTriggerStart(slash.start)
      return
    }
    if (at) {
      const queryChanged = atQueryRef.current !== at.query
      const wasClosed = !atOpenRef.current
      const startChanged = atTriggerStartRef.current !== at.start
      const slashWasOpen = slashOpenRef.current
      atQueryRef.current = at.query
      atOpenRef.current = true
      slashOpenRef.current = false
      atTriggerStartRef.current = at.start
      if (wasClosed) setAtOpen(true)
      if (slashWasOpen) setSlashOpen(false)
      if (wasClosed || queryChanged) {
        setAtQuery(at.query)
        setAtActive(0)
      }
      if (wasClosed || startChanged) setAtTriggerStart(at.start)
      return
    }
    if (slashOpenRef.current || atOpenRef.current) {
      slashQueryRef.current = ''
      atQueryRef.current = ''
      slashOpenRef.current = false
      atOpenRef.current = false
      setSlashOpen(false)
      setAtOpen(false)
    }
  }, [])

  function clearTriggerFromText(triggerStart: number, caret: number): { chips: ReturnType<typeof chipsFromValue>['chips']; text: string } {
    const { chips, text } = chipsFromValue(inputMessage)
    const nextText = `${text.slice(0, triggerStart)}${text.slice(caret)}`
    return { chips, text: nextText }
  }

  function onPickSkill(skill: PortalSkillItem): void {
    bumpSkillUsage(skill.name)
    const { chips, text } = clearTriggerFromText(slashTriggerStart, textCaretRef.current)
    const chip = makeChip({
      kind: 'skill',
      marker: skillMarker(skill.name),
      label: mentionLabel('skill', skill.name),
    })
    setInputMessage(serializeComposer([...chips, chip], text))
    slashOpenRef.current = false
    setSlashOpen(false)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  function onPickCommand(cmd: PortalSlashCommand): void {
    bumpSlashUsage(cmd.id)
    const action = cmd.action
    if (action.type === 'toggle-plan') {
      const { chips, text } = clearTriggerFromText(slashTriggerStart, textCaretRef.current)
      setInputMessage(serializeComposer(chips, text))
      slashOpenRef.current = false
      setSlashOpen(false)
      if (state.status !== 'open') {
        toast.error('Not connected')
        return
      }
      send(state.planMode ? '/plan off' : '/plan on')
      return
    }
    if (action.type === 'send') {
      const { chips, text } = clearTriggerFromText(slashTriggerStart, textCaretRef.current)
      setInputMessage(serializeComposer(chips, text))
      slashOpenRef.current = false
      setSlashOpen(false)
      if (state.status !== 'open') {
        toast.error('Not connected')
        return
      }
      send(action.text)
      return
    }
    // fill
    const caret = textCaretRef.current
    const { chips } = clearTriggerFromText(slashTriggerStart, caret)
    const { text: rest } = chipsFromValue(inputMessage)
    const after = rest.slice(caret)
    setInputMessage(serializeComposer(chips, `${action.text}${after}`))
    slashOpenRef.current = false
    setSlashOpen(false)
    requestAnimationFrame(() => {
      const ta = composerInputRef.current
      if (!ta) return
      ta.focus()
      const pos = action.text.length
      ta.setSelectionRange(pos, pos)
      syncTriggers(pos, action.text + after)
    })
  }

  function onPickWorkspace(): void {
    const { chips, text } = clearTriggerFromText(atTriggerStart, textCaretRef.current)
    const chip = makeChip({
      kind: 'workspace',
      marker: workspaceMarker(),
      label: mentionLabel('workspace'),
    })
    setInputMessage(serializeComposer([...chips, chip], text))
    atOpenRef.current = false
    setAtOpen(false)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  function onPickWorkspaceFile(relPath: string, isDir: boolean): void {
    const { chips, text } = clearTriggerFromText(atTriggerStart, textCaretRef.current)
    const kind = isDir ? 'dir' as const : 'file' as const
    const chip = makeChip({
      kind,
      marker: workspaceFileMarker(relPath, isDir),
      label: mentionLabel(kind, relPath),
      path: relPath,
    })
    setInputMessage(serializeComposer([...chips, chip], text))
    atOpenRef.current = false
    setAtOpen(false)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    const ne = e.nativeEvent as { isComposing?: boolean }
    // keyCode 229 = IME commit on some browsers before isComposing clears.
    if (ne.isComposing || e.keyCode === 229) return

    if (slashOpen || atOpen) {
      // Capture-phase popup listeners move highlight / commit selection;
      // block caret motion and accidental newlines / sends here.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        slashOpenRef.current = false
        atOpenRef.current = false
        setSlashOpen(false)
        setAtOpen(false)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
      }
      return
    }

    // Desktop/browser: Enter sends; Ctrl/⌘(+Shift)+Enter inserts a newline.
    // Phone: Enter never sends — only the send button submits.
    if (shouldSubmitOnEnterKey(e, { enterNewline })) {
      e.preventDefault()
      e.stopPropagation()
      void onSend()
    }
  }

  const fillComposer = useCallback((text: string): void => {
    setInputMessage(text)
    requestAnimationFrame(() => {
      const ta = composerInputRef.current
      if (!ta) return
      ta.focus()
      const { text: plain } = chipsFromValue(text)
      const pos = plain.length
      ta.setSelectionRange(pos, pos)
      syncTriggers(pos, plain)
    })
  }, [syncTriggers])

  function reeditPending(id: string): void {
    const item = pendingSends.find((row) => row.id === id)
    if (!item) return
    const draft = inputMessage.trim()
    setPendingSends((cur) => {
      const next = cur.filter((row) => row.id !== id)
      if (!draft) return next
      return [...next, { id: `q-${Date.now()}-${next.length}`, text: draft }]
    })
    fillComposer(item.text)
  }

  const emptyChatSlot = useMemo(() => (
    <PortalEmptyChat
      dark={theme === 'dark'}
      agentId={agentId}
      visual={visual}
      AgentIcon={AgentIcon}
      onFillPrompt={onFillPrompt}
    />
  ), [theme, agentId, visual, AgentIcon, onFillPrompt])

  function selectAgent(id: string): void {
    switchAgent(id)
    setActiveTab('chat')
    setShowModelDropdown(false)
    setSidebarOpen(false)
  }

  const dark = theme === 'dark'
  const composerMenuOpen = plusMenuOpen || slashOpen || atOpen
  const sidePanelProps = {
    dark,
    agentId,
    visual,
    AgentIcon,
    activeTab,
    status: state.status,
    lang: prefs.lang,
    onClose: () => setSidebarOpen(false),
    onChat: () => { setActiveTab('chat'); setSidebarOpen(false) },
    onExplore: () => { setActiveTab('explore'); setSidebarOpen(false) },
    onNew: () => { newConversation(); setSidebarOpen(false); setActiveTab('chat') },
    onToggleLang: toggleLang,
    sessions,
    activeSessionId,
    onSwitchSession: (threadId: string) => {
      switchSession(threadId)
      setActiveTab('chat')
      setSidebarOpen(false)
    },
    workspaces,
    activeWorkspaceId,
    collapsedWorkspaces,
    onToggleWorkspace: toggleWorkspaceCollapsed,
    onSelectWorkspace: (id: string) => {
      setActiveWorkspace(id)
      const ws = findWorkspace(id)
      syncWorkspace(ws?.kind === 'local' ? (ws.path || ws.name) : '')
    },
    onNewWorkspace: () => setWorkspacePickerOpen(true),
  } as const

  return (
    <div
      style={viewportStyle}
      className={cn(
        'flex flex-col overflow-hidden font-sans selection:bg-teal-500/30 lg:flex-row',
        dark ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-100 text-zinc-900',
      )}
    >
      <LlmSettingsDialog
        open={llmSettingsOpen}
        onOpenChange={setLlmSettingsOpen}
      />
      <NativeSetupDialog
        open={nativeSetupDialogOpen}
        reason={nativeSetupReason}
        onOpenChange={setNativeSetupDialogOpen}
        onConfigured={() => switchAgent('agim')}
      />
      <PortalWorkspacePicker
        open={workspacePickerOpen}
        agentId={agentId}
        onOpenChange={setWorkspacePickerOpen}
        onPicked={(dir) => {
          const ws = addLocalWorkspace(dir)
          const sess = findSession(activeSessionId)
          const blank = !state.messages.some((m) => m.role === 'user' && m.content.trim())
          if (sess && blank) upsertSession({ id: sess.id, workspaceId: ws.id })
          syncWorkspace(ws.kind === 'local' ? (ws.path || ws.name) : '')
        }}
      />
      {/* Desktop rail — always visible ≥ lg */}
      <aside
        className={cn(
          'hidden h-full w-64 shrink-0 flex-col justify-between border-r p-5 lg:flex',
          dark ? 'border-zinc-800 bg-[#121214]' : 'border-zinc-200 bg-white',
        )}
        aria-label={t('chat.portal.brand')}
      >
        <PortalSidePanel {...sidePanelProps} showClose={false} />
      </aside>

      {/* Main surface — blurred only while the mobile drawer is open */}
      <div
        className={cn(
          'relative flex min-h-0 min-w-0 flex-1 flex-col transition-[filter,opacity] duration-300',
          sidebarOpen && 'max-lg:pointer-events-none max-lg:select-none max-lg:blur-[6px] max-lg:brightness-75',
        )}
        aria-hidden={(sidebarOpen ? true : undefined)}
        data-agim-composer-sheet-root
        data-agim-sheet-column="portal"
      >
        <PortalHeader
          dark={dark}
          agentId={agentId}
          agentsCatalog={agentsCatalog}
          showModelDropdown={showModelDropdown}
          onToggleModelDropdown={() => setShowModelDropdown((v) => !v)}
          onCloseModelDropdown={() => setShowModelDropdown(false)}
          onSelectAgent={selectAgent}
          onOpenExplore={() => { setActiveTab('explore'); setShowModelDropdown(false) }}
          onOpenSidebar={() => setSidebarOpen(true)}
          onToggleTheme={() => setTheme(dark ? 'light' : 'dark')}
        />

        {/* Chat — keep mounted (hidden on Explore) so scroll position + follow-latch survive tab switches. */}
        <PortalMessageList
          dark={dark}
          active={activeTab === 'chat'}
          chatTurns={chatTurns}
          isEmpty={chatMessages.length === 0}
          isTyping={isTyping}
          currentReplyId={state.currentReplyId}
          streamingFallback={streamingFallback}
          agentId={agentId}
          agentColor={visual.color}
          AgentIcon={AgentIcon}
          portalThreadId={portalThreadId}
          listRef={messagesListRef}
          onFillComposer={fillComposer}
          onStopSubagent={onStopSubagent}
          emptySlot={emptyChatSlot}
        />

        {/* Explore */}
        {activeTab === 'explore' && (
          <PortalExplore
            dark={dark}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            exploreCategory={exploreCategory}
            onCategoryChange={setExploreCategory}
            filteredAgents={filteredAgents}
            onSelectAgent={selectAgent}
            onClose={() => setActiveTab('chat')}
          />
        )}

        {/* Docks + composer */}
        {activeTab === 'chat' && (
          <div className={cn(
            'absolute inset-x-0 bottom-0 px-4 pt-8 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
            // Lift above header (z-30) while + / slash / @ menu is open so it isn't clipped/covered.
            composerMenuOpen ? 'z-50' : 'z-20',
            dark ? 'bg-gradient-to-t from-zinc-950 via-zinc-950/95 to-transparent' : 'bg-gradient-to-t from-zinc-100 via-zinc-100/95 to-transparent',
          )}>
            <div className="pointer-events-none relative z-40 mx-auto flex h-0 max-w-[750px] justify-center">
              <ChatJumpToLatest
                show={showJumpToLatest}
                dark={dark}
                onJump={stickToBottom}
                className="pointer-events-auto absolute left-1/2 -top-1 -translate-x-1/2 -translate-y-full"
              />
            </div>
            <div className="mx-auto w-full max-w-[750px]">
              <Suspense fallback={null}>
                <PortalLoopDock
                  threadId={portalThreadId}
                  refreshKey={loopRefreshKey}
                  dark={dark}
                  agentId={agentId}
                  preferredWorkerAgent={state.preferredWorkerAgent}
                  onSwitchToAgimParent={() => switchAgent('agim')}
                  busy={canStop}
                  hasBlockingDock={hasBlockingDock}
                  flush
                  onSend={onLoopSend}
                />
              </Suspense>
              <ApprovalDock
                flush
                approvals={state.pendingApprovals}
                onApprove={(mid, reqId, choice) => approvalClick(mid, reqId, choice)}
              />
              <AskDock
                flush
                asks={state.pendingAsks}
                onSubmit={(mid, data) => choiceSubmit(mid, data)}
              />
              <div className="relative">
                <PortalPet
                  dark={dark}
                  busy={canStop || threadBgjobs.length > 0 || demoPet}
                  tasks={petTasks}
                  announce={petAnnounce}
                  onAnnounceDone={(id) => {
                    setPetAnnounce((cur) => (cur?.id === id ? null : cur))
                  }}
                  className="absolute bottom-[calc(100%-0.55rem)] right-1 z-[5]"
                />
                <div className="absolute bottom-full left-0 right-[5.25rem] z-30 mb-1.5 space-y-1">
                  <PortalSteerQueue
                    dark={dark}
                    items={pendingSends}
                    onSend={flushPending}
                    onDismiss={dismissPending}
                    onReedit={reeditPending}
                  />
                  <AttachmentStrip
                    dark={dark}
                    attachments={attachments}
                    onRemove={(id) => {
                      const target = attachments.find((a) => a.id === id)
                      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
                      setAttachments(attachments.filter((a) => a.id !== id))
                    }}
                    className=""
                  />
                </div>
                <form
                  ref={composerFormRef}
                  onSubmit={(e) => { void onSend(e) }}
                  className={cn(
                    'relative z-10 flex items-center justify-between rounded-[26px] border p-1 shadow-lg transition-all focus-within:border-teal-500',
                    dark ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-white',
                  )}
                >
                  <PortalComposerPlus
                    dark={dark}
                    planMode={state.planMode}
                    disabled={uploading || state.status !== 'open'}
                    attachments={attachments}
                    onAttachmentsChange={setAttachments}
                    onFillInput={fillComposer}
                    onOpenChange={setPlusMenuOpen}
                    onSendCommand={(cmd) => {
                      if (state.status !== 'open') {
                        toast.error('Not connected')
                        return
                      }
                      send(cmd)
                    }}
                  />
                  <PortalComposerInput
                    dark={dark}
                    value={inputMessage}
                    onChange={setInputMessage}
                    disabled={uploading}
                    enterNewline={enterNewline}
                    placeholder={t('chat.portal.messagePlaceholder', { agent: displayAgentName(agentId) })}
                    inputRef={composerInputRef}
                    onKeyDown={onComposerKeyDown}
                    onCaretChange={syncTriggers}
                  />
                  <PortalSlashPopup
                    dark={dark}
                    open={slashOpen}
                    query={slashQuery}
                    formRef={composerFormRef}
                    planMode={state.planMode}
                    activeIndex={slashActive}
                    onActiveIndexChange={setSlashActive}
                    onPickCommand={onPickCommand}
                    onPickSkill={onPickSkill}
                    onClose={() => setSlashOpen(false)}
                  />
                  <PortalAtPopup
                    dark={dark}
                    open={atOpen}
                    query={atQuery}
                    agentId={agentId}
                    formRef={composerFormRef}
                    activeIndex={atActive}
                    onActiveIndexChange={setAtActive}
                    onPickWorkspace={onPickWorkspace}
                    onPickFile={onPickWorkspaceFile}
                    onClose={() => setAtOpen(false)}
                  />
                  <div className="flex items-center gap-1 self-center">
                    {(inputMessage.trim() || attachments.length > 0) && !canStop ? (
                      <button
                        type="submit"
                        disabled={uploading}
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full shadow-md transition-all disabled:opacity-50',
                          dark ? 'bg-zinc-100 text-zinc-950 hover:bg-white' : 'bg-zinc-900 text-zinc-100 hover:bg-black',
                        )}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                    ) : canStop ? (
                      <>
                        {(inputMessage.trim() || attachments.length > 0) ? (
                          <button
                            type="submit"
                            disabled={uploading}
                            className={cn(
                              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full shadow-md transition-all disabled:opacity-50',
                              dark ? 'bg-teal-400 text-zinc-950 hover:bg-teal-300' : 'bg-teal-600 text-white hover:bg-teal-700',
                            )}
                            title={t('chat.portal.enqueue', { defaultValue: '加入队列' })}
                            aria-label={t('chat.portal.enqueue', { defaultValue: '加入队列' })}
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => stop()}
                          className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full shadow-md transition-all',
                            dark ? 'bg-zinc-100 text-zinc-950 hover:bg-white' : 'bg-zinc-900 text-zinc-100 hover:bg-black',
                          )}
                          title={t('chat.portal.stop')}
                          aria-label={t('chat.portal.stop')}
                        >
                          <Square className="h-3 w-3 fill-current" />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onPointerDown={onVoicePointerDown}
                        onPointerMove={onVoicePointerMove}
                        onPointerUp={onVoicePointerUp}
                        onPointerCancel={onVoicePointerUp}
                        onContextMenu={(e) => e.preventDefault()}
                        className={cn(
                          'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors touch-none select-none',
                          voicePhase === 'listening' || voicePhase === 'cancel'
                            ? (dark ? 'bg-zinc-800 text-teal-400' : 'bg-zinc-100 text-teal-600')
                            : (dark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-teal-400' : 'text-zinc-400 hover:bg-zinc-100 hover:text-teal-600'),
                        )}
                        title={t('chat.portal.voiceHold', { defaultValue: '按住说话' })}
                        aria-label={t('chat.portal.voiceHold', { defaultValue: '按住说话' })}
                      >
                        {(voicePhase === 'listening' || voicePhase === 'cancel') && (
                          <span
                            className={cn(
                              'pointer-events-none absolute inset-[-6px] rounded-full',
                              voicePhase === 'cancel' ? 'bg-zinc-400/25' : 'bg-teal-500/20',
                            )}
                            style={{ transform: `scale(${1 + voiceLevel * 0.45})` }}
                          />
                        )}
                        <Mic className="relative h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </form>
                <ComposerStatusBar
                  dark={dark}
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
                      toast.error('Not connected')
                      return
                    }
                    setOptimisticModel(backendName)
                    send(`/model ${backendName}`)
                  }}
                  onSendCommand={(cmd) => {
                    if (state.status !== 'open') {
                      toast.error('Not connected')
                      return
                    }
                    if (cmd.startsWith('/think')) {
                      const level = cmd.replace(/^\/think\s*/, '').trim() || 'auto'
                      setOptimisticThink(level)
                    }
                    if (cmd.startsWith('/ctx')) {
                      const next = cmd.replace(/^\/ctx\s*/, '').trim() || 'auto'
                      setOptimisticCompactRate(next)
                    }
                    send(cmd)
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mobile drawer — lg+ uses the persistent rail instead */}
      {sidebarOpen && (
        <div className="absolute inset-0 z-40 lg:hidden">
          <button
            type="button"
            className={cn(
              'absolute inset-0 transition-opacity duration-300',
              dark ? 'bg-black/40' : 'bg-zinc-900/25',
            )}
            aria-label="Close menu"
            onClick={() => setSidebarOpen(false)}
          />
          <div className={cn(
            'absolute inset-y-0 left-0 z-10 flex h-full w-[min(20rem,78%)] animate-in slide-in-from-left flex-col justify-between border-r p-6 shadow-2xl duration-300',
            dark ? 'border-zinc-800 bg-[#121214]' : 'border-zinc-200 bg-white',
          )}>
            <PortalSidePanel {...sidePanelProps} showClose />
          </div>
        </div>
      )}

      {voicePhase && (
        <VoiceInputOverlay phase={voicePhase} level={voiceLevel} dark={dark} />
      )}
    </div>
  )
}
