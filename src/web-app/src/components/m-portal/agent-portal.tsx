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
  useCallback, useEffect, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowUp, Bot, ChevronDown, ChevronRight, Compass, Languages, Menu, MessageSquare,
  Mic, Moon, Plus, Search, Sparkles, Square, Sun, User, X,
} from 'lucide-react'
import { toast } from 'sonner'

import { useChat, type ChatMessage } from '@/hooks/use-chat'
import { useChatFollowBottom } from '@/hooks/use-chat-scroll'
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
import { MarkdownView } from '@/components/chat/markdown-view'
import { MessageActions } from '@/components/chat/message-actions'
import { usePrefs, type Lang, type ThemeMode } from '@/stores/prefs'
import { cn } from '@/lib/utils'
import { agentVisual, displayAgentName, type AgentVisual } from './agent-visuals'
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
import { useBgjobs } from '@/hooks/use-bgjobs'
import type { BgjobSummary } from '@/types/api'
import { PortalPet, type PetAnnounce, type PetTaskItem } from './portal-pet'
import { PortalRunStatus } from './portal-run-status'
import {
  skillMarker,
  workspaceFileMarker,
  workspaceMarker,
  type PortalSkillItem,
  type PortalSlashCommand,
} from './portal-slash-commands'
import { PortalUserContent } from './portal-user-content'
import { VoiceInputOverlay, type VoiceInputPhase } from './voice-input-overlay'
import {
  getVoiceRecordingBlockReason,
  isVoiceRecordingSupported,
  transcribeVoiceBlob,
  VoiceRecorder,
} from '@/lib/voice-recorder'

type Tab = 'chat' | 'explore'
type Theme = 'dark' | 'light'

const EXPLORE_CATS = ['All', 'Featured', 'Programming', 'Writing', 'Design', 'Lifestyle'] as const

/** One user turn + following assistant/system replies (until the next user). */
interface ChatTurn {
  id: string
  user?: ChatMessage
  replies: ChatMessage[]
}

function groupChatTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  let current: ChatTurn | null = null
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (current) turns.push(current)
      current = { id: msg.id, user: msg, replies: [] }
      continue
    }
    if (!current) {
      current = { id: `orphan-${msg.id}`, replies: [msg] }
    } else {
      current.replies.push(msg)
    }
  }
  if (current) turns.push(current)
  return turns
}

function resolveTheme(mode: ThemeMode): Theme {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

/** Local visual QA only (`/m/chat?demo=width`) — seeds a wide markdown
 *  table so AI reply column width can be screenshotted without a live agent. */
function widthDemoMessages(): ChatMessage[] {
  const now = Date.now()
  return [
    {
      id: 'demo-width-user',
      role: 'user',
      content: '请帮我详细对比一下中证A50和中证A500这两个指数，我打算配置养老金，不知道选哪个更合适？',
      timestamp: now - 60_000,
    },
    {
      id: 'demo-width-assistant',
      role: 'assistant',
      agent: 'agim',
      timestamp: now - 1_000,
      activity: {
        runId: 'demo-width-run',
        status: 'success',
        startedAt: now - 59_000,
        finishedAt: now - 1_000,
        durationMs: 58_000,
        steps: [
          { id: 't1', kind: 'tool', label: 'web_search', status: 'success', startedAt: now - 58_000, finishedAt: now - 50_000 },
          { id: 't2', kind: 'tool', label: 'fetch', status: 'success', startedAt: now - 50_000, finishedAt: now - 40_000 },
          { id: 't3', kind: 'tool', label: 'analyze', status: 'success', startedAt: now - 40_000, finishedAt: now - 30_000 },
          { id: 't4', kind: 'tool', label: 'compare', status: 'success', startedAt: now - 30_000, finishedAt: now - 20_000 },
          { id: 't5', kind: 'tool', label: 'summarize', status: 'success', startedAt: now - 20_000, finishedAt: now - 10_000 },
          { id: 's1', kind: 'skill', label: 'market', status: 'success', startedAt: now - 45_000, finishedAt: now - 35_000 },
          { id: 's2', kind: 'skill', label: 'pension', status: 'success', startedAt: now - 35_000, finishedAt: now - 25_000 },
          { id: 's3', kind: 'skill', label: 'index', status: 'success', startedAt: now - 25_000, finishedAt: now - 15_000 },
        ],
      },
      content: [
        '## 中证 A50 vs 中证 A500（养老金配置向）',
        '',
        '| 维度 | 中证 A50 | 中证 A500 |',
        '| --- | --- | --- |',
        '| 样本空间 | 沪深市场超大盘龙头 | 剔除超大盘后的中大盘 |',
        '| 行业结构 | 金融/消费权重更高 | 制造/科技更均衡 |',
        '| 波动特征 | 相对更稳、弹性略低 | 弹性更大、回撤也更大 |',
        '| 适合谁 | 求稳、核心底仓 | 增强收益、卫星仓 |',
        '',
        '简要建议：养老金核心仓可偏 A50，卫星仓再用 A500 做增强；具体比例按风险承受能力调整。',
      ].join('\n'),
    },
  ]
}

/** Local visual QA (`/m/chat?demo=pet`) — running activity for the pet panel. */
function petDemoMessages(): ChatMessage[] {
  const now = Date.now()
  return [
    {
      id: 'demo-pet-user',
      role: 'user',
      content: '帮我查一下今天大盘，并整理成三条要点。',
      timestamp: now - 20_000,
    },
    {
      id: 'demo-pet-assistant',
      role: 'assistant',
      agent: 'agim',
      timestamp: now - 5_000,
      activity: {
        runId: 'demo-pet-run',
        status: 'running',
        startedAt: now - 18_000,
        steps: [
          { id: 't1', kind: 'tool', label: 'web_search', status: 'success', startedAt: now - 17_000, finishedAt: now - 12_000 },
          { id: 't2', kind: 'tool', label: 'summarize', status: 'running', startedAt: now - 11_000 },
        ],
      },
      content: '正在整理要点…',
    },
  ]
}

/** Local visual QA (`/m/chat?demo=todo`) — Cursor-style plan checklist card. */
function todoDemoMessages(): ChatMessage[] {
  const now = Date.now()
  return [
    {
      id: 'demo-todo-user',
      role: 'user',
      content: '帮我评估一下科技板块仓位，给出结论和操作建议。',
      timestamp: now - 40_000,
    },
    {
      id: 'demo-todo-assistant',
      role: 'assistant',
      agent: 'agim',
      timestamp: now - 5_000,
      activity: {
        runId: 'demo-todo-run',
        status: 'running',
        startedAt: now - 38_000,
        steps: [
          {
            id: 't-quote',
            kind: 'tool',
            label: 'agim_exec',
            status: 'running',
            startedAt: now - 20_000,
            preview: 'curl -s "http://localhost:8000/api/v1/tushare/hk/quote/daily"',
          },
          {
            id: 'agim-plan-checklist',
            kind: 'tool',
            label: 'agim_todo_write',
            status: 'success',
            startedAt: now - 37_000,
            finishedAt: now - 36_000,
            todoItems: [
              { content: '获取科技板块相关指数近期走势（科创50、恒生科技、纳斯达克、创业板50）', status: 'completed' },
              { content: '获取科技子板块行情（半导体、软件、通信、动漫游戏）', status: 'completed' },
              { content: '获取腾讯及港股科技龙头最新行情与估值', status: 'in_progress' },
              { content: '获取全球科技宏观事件与快讯', status: 'pending' },
              { content: '逐仓位评估持有逻辑是否成立，给出结论与操作建议', status: 'pending' },
              { content: '输出完整分析报告并落盘', status: 'pending' },
            ],
          },
        ],
      },
      content: '正在拉取腾讯及港股科技龙头行情…',
    },
  ]
}

/** Local visual QA (`/m/chat?demo=media`) — 8 image thumbs (5+3 wrap) + @file. */
function mediaDemoMessages(imagePaths: string[], filePath: string, fileName: string): ChatMessage[] {
  const now = Date.now()
  const markers = [
    ...imagePaths.map((p) => `[图片附件：${p}]`),
    `[文件附件：${filePath} (${fileName}, 12 B)]`,
  ]
  return [
    {
      id: 'demo-media-user',
      role: 'user',
      content: [...markers, 'see the photo'].join('\n'),
      timestamp: now - 10_000,
    },
  ]
}

/** Local visual QA (`/m/chat?demo=collapse`) — long user body for fold/mask. */
const COLLAPSE_DEMO_MESSAGES: ChatMessage[] = [
  {
    id: 'demo-collapse-user',
    role: 'user',
    content: [
      '1、老问题，这个输入款高度太高了',
      '2、/memo 应该自动填充 /memo here',
      '3、输入 / 或 @ 后，如果用的是键盘上下键选择，无法选择列表的选项。',
      '4、左侧的加号菜单，也加上 models、skills、remember',
      '5、消息体过长时需要默认折叠，点击后再展开',
      '6、选择文件夹/文件/skill 后，backspace 要能删掉 chip',
      '7、小精灵位置往上调，把脚挡住就行',
    ].join('\n'),
    timestamp: 0,
  },
]

function collapseDemoMessages(): ChatMessage[] {
  return COLLAPSE_DEMO_MESSAGES
}

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

  const { state, send, stop, switchAgent, approvalClick, choiceSubmit, newConversation, clearError } = useChat()
  useIosViewportZoomReset()
  const { style: viewportStyle } = usePortalViewportFrame()
  const [activeTab, setActiveTab] = useState<Tab>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [nativeSetupDialogOpen, setNativeSetupDialogOpen] = useState(false)
  const [nativeSetupReason, setNativeSetupReason] = useState('')
  const [llmSettingsOpen, setLlmSettingsOpen] = useState(false)
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
  const [voicePhase, setVoicePhase] = useState<VoiceInputPhase | null>(null)
  const [voiceLevel, setVoiceLevel] = useState(0.3)
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null)
  const voiceCancelRef = useRef(false)
  const voiceStartYRef = useRef(0)
  const voiceActiveRef = useRef(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [exploreCategory, setExploreCategory] = useState<(typeof EXPLORE_CATS)[number]>('All')
  const [inputMessage, setInputMessage] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const [petAnnounce, setPetAnnounce] = useState<PetAnnounce | null>(null)
  const enterNewline = useComposerEnterNewline()
  const [slashOpen, setSlashOpen] = useState(false)
  const [atOpen, setAtOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [atQuery, setAtQuery] = useState('')
  const [slashActive, setSlashActive] = useState(0)
  const [atActive, setAtActive] = useState(0)
  const [textCaret, setTextCaret] = useState(0)
  const [slashTriggerStart, setSlashTriggerStart] = useState(0)
  const [atTriggerStart, setAtTriggerStart] = useState(0)
  const messagesListRef = useRef<HTMLDivElement>(null)
  const activityStatusRef = useRef<Map<string, string>>(new Map())
  const composerFormRef = useRef<HTMLFormElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const slashQueryRef = useRef('')
  const atQueryRef = useRef('')
  const slashOpenRef = useRef(false)
  const atOpenRef = useRef(false)

  const agentId = state.agent || state.agents[0] || 'agim'
  const visual = agentVisual(agentId)
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
  const chatMessages = useMemo(
    () => {
      if (demoTodo) return todoDemoMessages()
      if (demoPet) return petDemoMessages()
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
    [demoTodo, demoPet, demoWidth, demoCollapse, demoMedia, state.messages],
  )
  const chatTurns = useMemo(() => groupChatTurns(chatMessages), [chatMessages])
  const currentReplyInList = chatMessages.some((m) => m.id === state.currentReplyId)
  // Fallback only when the placeholder message has not landed yet.
  const streamingFallback = isTyping && !currentReplyInList
  const canStop = isTyping || state.activeRunId != null

  const portalThreadId = state.clientId
  const { data: bgjobData } = useBgjobs(
    {
      root: 'agim',
      status: 'running,paused,starting',
      threadId: portalThreadId ?? undefined,
      platform: 'web',
    },
    { enabled: Boolean(portalThreadId) },
  )
  const threadBgjobs = useMemo((): BgjobSummary[] => {
    if (!bgjobData) return []
    const rows = bgjobData.jobs
      ?? bgjobData.groups?.flatMap((g) => g.jobs)
      ?? []
    if (!portalThreadId) return []
    return rows.filter((j) => j.origin?.threadId === portalThreadId)
  }, [bgjobData, portalThreadId])

  const seenBgjobIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const live = new Set(threadBgjobs.map((j) => j.id))
    // First paint: seed without announcing historical completions.
    if (seenBgjobIdsRef.current.size === 0 && live.size > 0) {
      seenBgjobIdsRef.current = live
      return
    }
    for (const id of seenBgjobIdsRef.current) {
      if (live.has(id)) continue
      seenBgjobIdsRef.current.delete(id)
      setPetAnnounce({
        id: `bgjob-done-${id}-${Date.now()}`,
        text: t('chat.portal.pet.bgjobDone'),
        tone: 'ok',
      })
    }
    for (const id of live) seenBgjobIdsRef.current.add(id)
  }, [threadBgjobs, t])

  const petTasks = useMemo((): PetTaskItem[] => {
    const items: PetTaskItem[] = []
    for (const msg of chatMessages) {
      if (msg.role !== 'assistant' || !msg.activity) continue
      if (msg.activity.status !== 'running') continue
      const live = [...msg.activity.steps].reverse().find(
        (s) => s.status === 'running' || s.status === 'pending',
      )
      items.push({
        id: `run-${msg.activity.runId || msg.id}`,
        kind: 'run',
        label: msg.agent ? displayAgentName(msg.agent) : t('chat.portal.pet.runLabel'),
        detail: live?.label
          || t('chat.activityRunning', { defaultValue: 'Running' }),
      })
    }
    if (isTyping && !items.some((i) => i.kind === 'run')) {
      items.push({
        id: `run-${state.currentReplyId ?? 'streaming'}`,
        kind: 'run',
        label: displayAgentName(agentId),
        detail: t('chat.activityRunning', { defaultValue: 'Running' }),
      })
    }
    for (const ap of state.pendingApprovals) {
      if (ap.outcome) continue
      items.push({
        id: `apv-${ap.messageId}`,
        kind: 'approval',
        label: t('chat.portal.pet.approvalLabel'),
        detail: ap.prompt?.toolName || undefined,
      })
    }
    for (const ask of state.pendingAsks) {
      if (ask.finalText) continue
      items.push({
        id: `ask-${ask.messageId}`,
        kind: 'ask',
        label: t('chat.portal.pet.askLabel'),
        detail: ask.prompt?.body || ask.prompt?.title || undefined,
      })
    }
    for (const job of threadBgjobs) {
      const prog = job.progress
      let detail = t(`chat.portal.pet.bgjobStatus.${job.status}`, { defaultValue: job.status })
      let progressPct: number | null = null
      if (prog?.total && prog.total > 0 && prog.done != null) {
        progressPct = Math.round((100 * prog.done) / prog.total)
        const stage = prog.stage || prog.label || ''
        detail = stage
          ? `${stage} ${prog.done}/${prog.total}`
          : `${prog.done}/${prog.total}`
        if (prog.eta_sec != null && prog.eta_sec > 0) {
          detail += ` · ETA ${Math.ceil(prog.eta_sec / 60)}m`
        }
      }
      items.push({
        id: `bgjob-${job.id}`,
        kind: 'bgjob',
        label: job.name || job.id,
        detail,
        progressPct,
      })
    }
    if (demoPet) {
      items.push(
        {
          id: 'demo-apv',
          kind: 'approval',
          label: t('chat.portal.pet.approvalLabel'),
          detail: 'bash',
        },
        {
          id: 'demo-ask',
          kind: 'ask',
          label: t('chat.portal.pet.askLabel'),
          detail: '要用简洁版还是详细版？',
        },
        {
          id: 'demo-bgjob',
          kind: 'bgjob',
          label: 'train-smoke',
          detail: 'B1 120/500 · ETA 6m',
          progressPct: 24,
        },
      )
    }
    return items
  }, [
    chatMessages,
    isTyping,
    state.currentReplyId,
    state.pendingApprovals,
    state.pendingAsks,
    threadBgjobs,
    agentId,
    demoPet,
    t,
  ])

  // Float a left-drifting bubble when a run finishes.
  useEffect(() => {
    const prev = activityStatusRef.current
    const next = new Map(prev)
    for (const msg of chatMessages) {
      if (msg.role !== 'assistant' || !msg.activity) continue
      const key = msg.activity.runId || msg.id
      const cur = msg.activity.status
      const was = prev.get(key)
      if (was === 'running' && (cur === 'success' || cur === 'error')) {
        const agent = msg.agent ? displayAgentName(msg.agent) : 'Agim'
        setPetAnnounce({
          id: `done-${key}-${cur}-${msg.activity.finishedAt ?? Date.now()}`,
          text: cur === 'success'
            ? t('chat.portal.pet.doneOk', { agent })
            : t('chat.portal.pet.doneErr', { agent }),
          tone: cur === 'success' ? 'ok' : 'err',
        })
      }
      next.set(key, cur)
    }
    activityStatusRef.current = next
  }, [chatMessages, t])

  // demo=pet — fire completion floats so recording can capture the drift.
  // Repeat every 4.5s: SPA soft-navigations keep demoPet=true without remount,
  // so a one-shot timeout is easy to miss on a second visit.
  useEffect(() => {
    if (!demoPet) return
    const fire = (): void => {
      setPetAnnounce({
        id: `demo-pet-done-${Date.now()}`,
        text: t('chat.portal.pet.doneOk', { agent: 'Agim' }),
        tone: 'ok',
      })
    }
    const first = window.setTimeout(fire, 1600)
    const loop = window.setInterval(fire, 4500)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(loop)
    }
  }, [demoPet, t])
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
  const { stickToBottom } = useChatFollowBottom({
    listRef: messagesListRef,
    messageCount: chatMessages.length,
    latestMessageContent: chatMessages[chatMessages.length - 1]?.content ?? '',
    streaming: isTyping,
    followSignal: chatMessages[chatMessages.length - 1]?.activity?.steps.length ?? 0,
  })

  const agentsCatalog = useMemo(() => {
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
      send(body)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('chat.portal.attach.uploadFailed', {
        defaultValue: '附件上传失败',
      }))
    } finally {
      setUploading(false)
    }
  }

  const endVoiceSession = useCallback(async (cancelled: boolean) => {
    if (!voiceActiveRef.current && !voiceRecorderRef.current) {
      setVoicePhase(null)
      return
    }
    voiceActiveRef.current = false
    const recorder = voiceRecorderRef.current
    voiceRecorderRef.current = null
    if (!recorder) {
      setVoicePhase(null)
      return
    }
    if (cancelled) {
      recorder.cancel()
      setVoicePhase(null)
      setVoiceLevel(0.3)
      return
    }
    setVoicePhase('transcribing')
    try {
      const clip = await recorder.stop()
      if (!clip || clip.durationMs < 280) {
        toast.error(t('chat.portal.voiceTooShort', { defaultValue: '说话时间太短' }))
        setVoicePhase(null)
        return
      }
      if (state.status !== 'open') {
        toast.error('Not connected')
        setVoicePhase(null)
        return
      }
      const { text } = await transcribeVoiceBlob(clip, {
        language: prefs.lang === 'zh' ? 'zh' : 'en',
      })
      const trimmed = text.trim()
      if (!trimmed) {
        toast.error(t('chat.portal.voiceEmpty', { defaultValue: '没有识别到语音' }))
        setVoicePhase(null)
        return
      }
      // Fill the composer so the user can edit before sending (WeChat-style).
      setInputMessage((prev) => {
        const { chips, text: plain } = chipsFromValue(prev)
        const nextPlain = plain.trim() ? `${plain.trim()} ${trimmed}` : trimmed
        return serializeComposer(chips, nextPlain)
      })
      setVoicePhase(null)
      requestAnimationFrame(() => {
        const ta = composerInputRef.current
        if (!ta) return
        ta.focus()
        const end = ta.value.length
        ta.setSelectionRange(end, end)
      })
      toast.success(t('chat.portal.voiceFilled', {
        defaultValue: '已填入输入框，确认后发送',
      }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('chat.portal.voiceFailed', {
        defaultValue: '语音识别失败',
      }))
      setVoicePhase(null)
    } finally {
      setVoiceLevel(0.3)
    }
  }, [prefs.lang, state.status, t])

  const onVoicePointerDown = useCallback(async (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (canStop || uploading || voicePhase === 'transcribing') return
    const voiceBlock = getVoiceRecordingBlockReason()
    if (voiceBlock) {
      const msg = voiceBlock === 'insecure'
        ? t('chat.portal.voiceInsecure', {
          defaultValue: '当前不是安全上下文，浏览器禁止录音。请用 https:// 打开（不要用 http://），或用 localhost',
        })
        : voiceBlock === 'no-mediarecorder'
          ? t('chat.portal.voiceNoMediaRecorder', {
            defaultValue: '当前浏览器/壳不支持 MediaRecorder（常见于旧版 iOS Safari）。请升级系统，或改用桌面 Chrome/Edge',
          })
          : t('chat.portal.voiceNoMediaDevices', {
            defaultValue: '无法访问麦克风 API（mediaDevices）。请确认用 https 打开、未禁用麦克风权限，且不在无权限的 iframe 内',
          })
      toast.error(msg)
      return
    }
    if (!isVoiceRecordingSupported()) {
      toast.error(t('chat.portal.voiceUnsupported', {
        defaultValue: '当前环境不支持录音',
      }))
      return
    }
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    voiceStartYRef.current = e.clientY
    voiceCancelRef.current = false
    voiceActiveRef.current = true
    setVoicePhase('listening')
    setVoiceLevel(0.3)
    const recorder = new VoiceRecorder({
      onLevel: (level) => setVoiceLevel(level),
      onError: (err) => toast.error(err.message),
    })
    voiceRecorderRef.current = recorder
    try {
      await recorder.start()
      // Released / cancelled while awaiting getUserMedia — drop the session.
      if (!voiceActiveRef.current || voiceRecorderRef.current !== recorder) {
        recorder.cancel()
        if (voiceRecorderRef.current === recorder) voiceRecorderRef.current = null
        if (!voiceActiveRef.current) setVoicePhase(null)
      }
    } catch (err) {
      voiceActiveRef.current = false
      voiceRecorderRef.current = null
      setVoicePhase(null)
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(
        /Permission|NotAllowed|denied/i.test(msg)
          ? t('chat.portal.voiceDenied', { defaultValue: '需要麦克风权限才能语音输入' })
          : /Invalid constraint|Overconstrained|constraint/i.test(msg)
            ? t('chat.portal.voiceConstraint', {
              defaultValue: '无法打开麦克风（未弹出权限框）。请：① 硬刷新页面或重启 Agim；② 系统设置 → 隐私 → 麦克风，允许浏览器/Agim；③ 地址栏站点权限里麦克风选「允许」',
            })
            : msg,
      )
    }
  }, [canStop, t, uploading, voicePhase])

  const onVoicePointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!voiceActiveRef.current || voicePhase === 'transcribing') return
    const dy = voiceStartYRef.current - e.clientY
    const cancel = dy > 72
    if (cancel !== voiceCancelRef.current) {
      voiceCancelRef.current = cancel
      setVoicePhase(cancel ? 'cancel' : 'listening')
    }
  }, [voicePhase])

  const onVoicePointerUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!voiceActiveRef.current && voicePhase !== 'listening' && voicePhase !== 'cancel') return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    const cancelled = voiceCancelRef.current
    void endVoiceSession(cancelled)
  }, [endVoiceSession, voicePhase])

  const syncTriggers = useCallback((caret: number, plainText: string) => {
    setTextCaret(caret)
    const slash = detectSlashTrigger(plainText, caret)
    const at = !slash ? detectAtTrigger(plainText, caret) : null
    if (slash) {
      const queryChanged = slashQueryRef.current !== slash.query
      const wasClosed = !slashOpenRef.current
      slashQueryRef.current = slash.query
      slashOpenRef.current = true
      atOpenRef.current = false
      setSlashOpen(true)
      setAtOpen(false)
      setSlashQuery(slash.query)
      setSlashTriggerStart(slash.start)
      if (wasClosed || queryChanged) setSlashActive(0)
    } else if (at) {
      const queryChanged = atQueryRef.current !== at.query
      const wasClosed = !atOpenRef.current
      atQueryRef.current = at.query
      atOpenRef.current = true
      slashOpenRef.current = false
      setAtOpen(true)
      setSlashOpen(false)
      setAtQuery(at.query)
      setAtTriggerStart(at.start)
      if (wasClosed || queryChanged) setAtActive(0)
    } else {
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
    const { chips, text } = clearTriggerFromText(slashTriggerStart, textCaret)
    const chip = makeChip({
      kind: 'skill',
      marker: skillMarker(skill.name),
      label: mentionLabel('skill', skill.name),
    })
    setInputMessage(serializeComposer([...chips, chip], text))
    setSlashOpen(false)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  function onPickCommand(cmd: PortalSlashCommand): void {
    bumpSlashUsage(cmd.id)
    const action = cmd.action
    if (action.type === 'toggle-plan') {
      const { chips, text } = clearTriggerFromText(slashTriggerStart, textCaret)
      setInputMessage(serializeComposer(chips, text))
      setSlashOpen(false)
      if (state.status !== 'open') {
        toast.error('Not connected')
        return
      }
      send(state.planMode ? '/plan off' : '/plan on')
      return
    }
    if (action.type === 'send') {
      const { chips, text } = clearTriggerFromText(slashTriggerStart, textCaret)
      setInputMessage(serializeComposer(chips, text))
      setSlashOpen(false)
      if (state.status !== 'open') {
        toast.error('Not connected')
        return
      }
      send(action.text)
      return
    }
    // fill
    const { chips } = clearTriggerFromText(slashTriggerStart, textCaret)
    const { text: rest } = chipsFromValue(inputMessage)
    const after = rest.slice(textCaret)
    setInputMessage(serializeComposer(chips, `${action.text}${after}`))
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
    const { chips, text } = clearTriggerFromText(atTriggerStart, textCaret)
    const chip = makeChip({
      kind: 'workspace',
      marker: workspaceMarker(),
      label: mentionLabel('workspace'),
    })
    setInputMessage(serializeComposer([...chips, chip], text))
    setAtOpen(false)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  function onPickWorkspaceFile(relPath: string, isDir: boolean): void {
    const { chips, text } = clearTriggerFromText(atTriggerStart, textCaret)
    const kind = isDir ? 'dir' as const : 'file' as const
    const chip = makeChip({
      kind,
      marker: workspaceFileMarker(relPath, isDir),
      label: mentionLabel(kind, relPath),
      path: relPath,
    })
    setInputMessage(serializeComposer([...chips, chip], text))
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

  function fillComposer(text: string): void {
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
  }

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
  } as const

  return (
    <div
      style={viewportStyle}
      className={cn(
        // Height/top come from visualViewport so iOS keyboard pan cannot
        // shove the header off-screen (sticky alone is not enough).
        // lg+: Cursor-like row — left rail + main column.
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
          // Blur/pointer lock is mobile-drawer only; lg rail never covers main.
          sidebarOpen && 'max-lg:pointer-events-none max-lg:select-none max-lg:blur-[6px] max-lg:brightness-75',
        )}
        aria-hidden={(sidebarOpen ? true : undefined)}
      >
      <header className={cn(
        // shrink-0 + portal VV frame = always visible at top of the
        // visible viewport (not document-sticky, which iOS still pans).
        'z-30 flex shrink-0 items-center justify-between border-b px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] transition-all',
        dark ? 'border-zinc-900 bg-zinc-950 text-white' : 'border-zinc-200 bg-white text-zinc-800',
      )}>
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className={cn(
            'rounded-lg p-1.5 transition lg:invisible lg:pointer-events-none',
            dark ? 'hover:bg-zinc-900' : 'hover:bg-zinc-100',
          )}
          aria-label={t('chat.portal.brand')}
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setShowModelDropdown((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition-all duration-300',
              dark ? 'border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800' : 'border-zinc-200 bg-zinc-100 text-zinc-800 hover:bg-zinc-200',
            )}
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            <span className="max-w-[120px] truncate">{displayAgentName(agentId)}</span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
          </button>

          {showModelDropdown && (
            <>
              <button type="button" className="fixed inset-0 z-[45] bg-black/40" aria-label="Close" onClick={() => setShowModelDropdown(false)} />
              <div className={cn(
                'absolute left-1/2 top-full z-50 mt-2 w-56 -translate-x-1/2 animate-in fade-in slide-in-from-top-2 rounded-2xl border p-2 shadow-2xl duration-200',
                dark ? 'border-zinc-800 bg-zinc-950 text-zinc-200' : 'border-zinc-200 bg-white text-zinc-800',
              )}>
                <p className="mb-1 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-zinc-400">{t('chat.portal.selectAgent')}</p>
                <div className="space-y-1">
                  {agentsCatalog.map((agent) => {
                    const Icon = agent.icon
                    const active = agent.id === agentId
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => selectAgent(agent.id)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-xl p-2 text-left text-xs transition-all',
                          active
                            ? (dark ? 'bg-zinc-800 text-teal-300' : 'bg-zinc-100 text-teal-600')
                            : (dark ? 'text-zinc-400 hover:bg-zinc-900/60' : 'text-zinc-600 hover:bg-zinc-50'),
                        )}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <div className={cn('rounded-md bg-gradient-to-tr p-1.5 text-white', agent.color)}>
                            <Icon className="h-3 w-3" />
                          </div>
                          <span className="truncate font-semibold">{agent.name}</span>
                        </div>
                        {active && <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                      </button>
                    )
                  })}
                </div>
                <div className={cn('mt-2 border-t px-2 pt-1.5', dark ? 'border-zinc-800' : 'border-zinc-200')}>
                  <button
                    type="button"
                    onClick={() => { setActiveTab('explore'); setShowModelDropdown(false) }}
                    className="flex w-full items-center gap-1.5 text-[10px] font-semibold text-zinc-400 hover:text-teal-400"
                  >
                    <Compass className="h-3.5 w-3.5" />
                    {t('chat.portal.discoverMore')}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setTheme(dark ? 'light' : 'dark')}
          className={cn(
            'rounded-lg p-1.5 transition',
            dark ? 'text-yellow-400 hover:bg-zinc-900' : 'text-indigo-500 hover:bg-zinc-100',
          )}
          title={t('chat.portal.toggleTheme')}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </header>

      {/* Chat */}
      {/* Keep the chat scroller mounted (hidden on Explore) so scroll
          position + follow-latch survive tab switches. */}
      <div
        ref={messagesListRef}
        className={cn(
          // pt-0 so sticky user chips sit flush under the header (no py gap when pinned).
          // pb leaves room for composer + perched pet.
          'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-0 pb-40 transition-colors duration-300 scrollbar-none',
          dark ? 'bg-zinc-950' : 'bg-zinc-100',
          activeTab !== 'chat' && 'hidden',
        )}
        aria-hidden={activeTab !== 'chat'}
      >
          <div className="mx-auto flex w-full max-w-[750px] flex-col space-y-4">
          {chatMessages.length === 0 && (
            <div className="flex animate-in fade-in flex-col items-center space-y-4 py-12 text-center duration-500">
              <div className={cn(
                'flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr text-white shadow-lg ring-4',
                dark ? 'ring-white/5' : 'ring-black/5',
                visual.color,
              )}>
                <AgentIcon className="h-7 w-7" />
              </div>
              <div>
                <h2 className={cn('text-lg font-bold tracking-tight', dark ? 'text-zinc-100' : 'text-zinc-800')}>
                  {displayAgentName(agentId)}
                </h2>
                <p className="mx-auto mt-1 max-w-[260px] text-xs leading-normal text-zinc-400">{visual.tagline}</p>
              </div>
              <div className="mt-4 grid w-full max-w-sm grid-cols-2 gap-2 pt-2 text-left">
                {[
                  { title: 'Brand Palettes', hint: 'Aesthetic color schemes for dark and light views.', prompt: 'Recommend 3 premium mock palettes for our brand layout.' },
                  { title: 'UI Architecture', hint: 'Configure viewport parameters across layout frameworks.', prompt: 'Structure a high performance responsive viewport architecture.' },
                ].map((card) => (
                  <button
                    key={card.title}
                    type="button"
                    onClick={() => setInputMessage(card.prompt)}
                    className={cn(
                      'cursor-pointer rounded-2xl border p-3.5 text-left transition-all',
                      dark
                        ? 'border-zinc-800 bg-zinc-900/70 hover:border-zinc-700 hover:bg-zinc-900'
                        : 'border-zinc-200 bg-white shadow-sm hover:border-zinc-300 hover:bg-white',
                    )}
                  >
                    <p className={cn('text-xs font-bold', dark ? 'text-zinc-300' : 'text-zinc-800')}>{card.title}</p>
                    <p className="mt-1 line-clamp-2 text-[10px] text-zinc-400">{card.hint}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {chatTurns.map((turn) => (
            <div key={turn.id} className="flex w-full flex-col gap-3">
              {turn.user && (
                <div
                  data-user-message
                  className={cn(
                    // Sticky topic chip — rounded rect (not a full pill/ellipse)
                    'sticky top-0 z-10 w-full min-w-0 overflow-hidden rounded-xl border px-4 py-3 text-left text-base font-medium leading-relaxed',
                    // Force wrap long unbroken tokens (digits / paths) inside the chip.
                    'whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]',
                    dark
                      ? 'border-zinc-700 bg-zinc-800 text-zinc-100'
                      : 'border-zinc-200 bg-white text-zinc-900',
                  )}
                  style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}
                >
                  <PortalUserContent
                    dark={dark}
                    content={turn.user.content}
                    messageId={turn.user.id}
                  />
                </div>
              )}
              {turn.replies.map((msg) => (
                <div
                  key={msg.id}
                  // AI reply column — slightly inset vs the full-width user
                  // chip, centered (equal left/right gap). min-w-0 so wide
                  // tables cannot expand past the cap.
                  className="mx-auto flex w-[95%] max-w-[95%] min-w-0 flex-col self-center overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300"
                  data-testid="portal-ai-reply"
                >
                  <div className="w-full min-w-0 space-y-1.5 overflow-x-auto">
                    {(() => {
                      const isCurrent = isTyping && msg.id === state.currentReplyId
                      // Prefer the message's own agent; never fall back to the
                      // currently selected agent (that recolors history on switch).
                      const stamped = msg.agent
                      const msgVisual = stamped
                        ? agentVisual(stamped)
                        : { color: 'from-zinc-500 to-zinc-600', icon: Bot, category: 'Featured', tagline: '' }
                      const MsgIcon = msgVisual.icon
                      const label = stamped ? displayAgentName(stamped) : 'Agent'
                      const showRun = !!msg.activity || isCurrent
                      if (showRun) {
                        return (
                          <PortalRunStatus
                            dark={dark}
                            agentName={label}
                            agentColor={msgVisual.color}
                            AgentIcon={MsgIcon}
                            activity={msg.activity}
                            streaming={isCurrent && (!msg.activity || msg.activity.status === 'running')}
                          />
                        )
                      }
                      return (
                        <div className="flex items-center gap-2">
                          <div className={cn('rounded-md bg-gradient-to-tr p-1 text-white', msgVisual.color)}>
                            <MsgIcon className="h-3.5 w-3.5" />
                          </div>
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                            {label}
                          </span>
                        </div>
                      )
                    })()}
                    {msg.content ? (
                      <div className={cn(
                        'min-w-0 select-text break-words text-base leading-relaxed',
                        dark ? 'text-zinc-200' : 'text-zinc-800',
                      )}>
                        <MarkdownView
                          content={msg.content}
                          className="break-words text-base leading-relaxed"
                        />
                        {!(isTyping && msg.id === state.currentReplyId) && (
                          <MessageActions
                            key={`${msg.id}:${msg.feedback ?? ''}`}
                            content={msg.content}
                            dark={dark}
                            threadId={portalThreadId || undefined}
                            messageId={msg.id}
                            messageIndex={msg.serverIndex}
                            initialVote={msg.feedback ?? null}
                            onDownvotePrefill={() => fillComposer(t('chat.portal.feedbackPrefill'))}
                          />
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {streamingFallback && (
            <div className="mx-auto w-[95%] max-w-[95%] min-w-0 self-center" data-testid="portal-ai-reply-streaming">
              <PortalRunStatus
                dark={dark}
                agentName={displayAgentName(agentId)}
                agentColor={visual.color}
                AgentIcon={AgentIcon}
                streaming
              />
            </div>
          )}
          </div>
      </div>

      {/* Explore */}
      {activeTab === 'explore' && (
        <div className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pb-8 transition-colors duration-300 scrollbar-none',
          dark ? 'bg-zinc-950' : 'bg-zinc-100',
        )}>
          <div className="mx-auto w-full max-w-[750px] space-y-6">
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <h2 className={cn('text-lg font-black tracking-tight', dark ? 'text-white' : 'text-zinc-800')}>{t('chat.portal.exploreTitle')}</h2>
              <button
                type="button"
                onClick={() => setActiveTab('chat')}
                aria-label={t('chat.portal.closeExplore', { defaultValue: 'Close' })}
                title={t('chat.portal.closeExplore', { defaultValue: 'Close' })}
                className={cn(
                  'mt-0.5 shrink-0 rounded-full p-1.5 transition',
                  dark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100' : 'text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800',
                )}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[11px] leading-normal text-zinc-400">
              {t('chat.portal.exploreSubtitle')}
            </p>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              placeholder={t('chat.portal.searchAgents')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={cn(
                // text-md (16px) — iOS Safari auto-zooms focused inputs under 16px
                'w-full rounded-xl border py-2 pl-9 pr-4 text-md transition-all focus:border-teal-500 focus:outline-none',
                dark
                  ? 'border-zinc-800 bg-zinc-900 text-zinc-200 placeholder:text-zinc-500'
                  : 'border-zinc-200 bg-white text-zinc-800 placeholder:text-zinc-400 shadow-sm',
              )}
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="h-3.5 w-3.5 text-zinc-400 hover:text-zinc-600" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {EXPLORE_CATS.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setExploreCategory(cat)}
                className={cn(
                  'whitespace-nowrap rounded-full px-3 py-1 text-[10px] font-bold transition-all',
                  exploreCategory === cat
                    ? 'border border-teal-500/30 bg-teal-500/20 text-teal-400'
                    : dark
                      ? 'bg-zinc-900 text-zinc-400 hover:text-white'
                      : 'bg-zinc-200/60 text-zinc-600 hover:bg-zinc-200',
                )}
              >
                {cat === 'All' ? t('chat.portal.cats.All')
                  : cat === 'Featured' ? t('chat.portal.cats.Featured')
                    : cat === 'Programming' ? t('chat.portal.cats.Programming')
                      : cat === 'Writing' ? t('chat.portal.cats.Writing')
                        : cat === 'Design' ? t('chat.portal.cats.Design')
                          : t('chat.portal.cats.Lifestyle')}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">
              {t('chat.portal.directoryResults', { count: filteredAgents.length })}
            </p>
            <div className="space-y-2.5">
              {filteredAgents.map((agent) => {
                const Icon = agent.icon
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => selectAgent(agent.id)}
                    className={cn(
                      'group flex w-full items-start justify-between rounded-2xl border p-3 text-left transition-all',
                      dark
                        ? 'border-zinc-900 bg-zinc-900/40 hover:border-zinc-800 hover:bg-zinc-900'
                        : 'border-zinc-200 bg-white shadow-sm hover:bg-zinc-100/50',
                    )}
                  >
                    <div className="flex items-start gap-3 truncate">
                      <div className={cn('shrink-0 rounded-xl bg-gradient-to-tr p-2 text-white shadow-sm', agent.color)}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="truncate text-left">
                        <div className="flex items-center gap-2">
                          <h3 className={cn(
                            'text-xs font-bold transition-colors group-hover:text-teal-500',
                            dark ? 'text-zinc-200' : 'text-zinc-800',
                          )}>
                            {agent.name}
                          </h3>
                          <span className={cn(
                            'rounded-full px-1.5 py-0.5 text-[8px] font-bold',
                            dark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-500',
                          )}>
                            {agent.category}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-zinc-400">{agent.tagline}</p>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 self-center text-zinc-400" />
                  </button>
                )
              })}
              {filteredAgents.length === 0 && (
                <p className="py-8 text-center text-xs text-zinc-400">{t('chat.portal.noAgents')}</p>
              )}
            </div>
          </div>

          <div className={cn(
            'space-y-3 rounded-3xl border p-4 text-center',
            dark
              ? 'border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950'
              : 'border-zinc-200/80 bg-zinc-100 shadow-sm',
          )}>
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-teal-500/10 text-teal-500">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h3 className={cn('text-xs font-bold', dark ? 'text-zinc-200' : 'text-zinc-800')}>{t('chat.portal.ideaTitle')}</h3>
              <p className="mt-0.5 text-[10px] text-zinc-400">{t('chat.portal.ideaBody')}</p>
            </div>
          </div>
          </div>
        </div>
      )}

      {/* Docks + composer */}
      {activeTab === 'chat' && (
        <div className={cn(
          'absolute inset-x-0 bottom-0 px-4 pt-8 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
          // Lift above header (z-30) while + / slash / @ menu is open so it isn't clipped/covered.
          composerMenuOpen ? 'z-50' : 'z-20',
          dark ? 'bg-gradient-to-t from-zinc-950 via-zinc-950/95 to-transparent' : 'bg-gradient-to-t from-zinc-100 via-zinc-100/95 to-transparent',
        )}>
          <div className="mx-auto w-full max-w-[750px]">
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
              // Perch on the form rim; z below the form so only feet tuck
              // under the opaque composer (not painted on top of it).
              className="absolute bottom-[calc(100%-0.55rem)] right-1 z-[5]"
            />
            <AttachmentStrip
              dark={dark}
              attachments={attachments}
              onRemove={(id) => {
                const target = attachments.find((a) => a.id === id)
                if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
                setAttachments(attachments.filter((a) => a.id !== id))
              }}
              // Float above the form; leave ~3.5rem on the right for the pet.
              className="absolute bottom-full left-0 z-20 mb-1.5 max-w-[calc(100%-3.5rem)]"
            />
            <form
              ref={composerFormRef}
              onSubmit={(e) => { void onSend(e) }}
              className={cn(
                // z-10 covers pet feet; menus are portaled to body so they are fine.
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
                onChange={(next) => {
                  setInputMessage(next)
                  const { text } = chipsFromValue(next)
                  const caret = composerInputRef.current?.selectionStart ?? text.length
                  syncTriggers(caret, text)
                }}
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
                      // Match + button: fixed h-7 w-7 circle.
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full shadow-md transition-all disabled:opacity-50',
                      dark ? 'bg-zinc-100 text-zinc-950 hover:bg-white' : 'bg-zinc-900 text-zinc-100 hover:bg-black',
                    )}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                ) : canStop ? (
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
                ) : (
                  <button
                    type="button"
                    onPointerDown={(e) => { void onVoicePointerDown(e) }}
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

function PortalSidePanel(props: {
  dark: boolean
  agentId: string
  visual: AgentVisual
  AgentIcon: LucideIcon
  activeTab: Tab
  status: string
  lang: Lang
  showClose: boolean
  onClose: () => void
  onChat: () => void
  onExplore: () => void
  onNew: () => void
  onToggleLang: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const {
    dark, agentId, visual, AgentIcon, activeTab, status, lang, showClose,
    onClose, onChat, onExplore, onNew, onToggleLang,
  } = props
  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-teal-500">
            <Sparkles className="h-5 w-5" />
            <span className="text-sm">{t('chat.portal.brand')}</span>
          </div>
          {showClose && (
            <button
              type="button"
              onClick={onClose}
              className={cn('rounded-full p-1.5 transition', dark ? 'text-zinc-400 hover:bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-100')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">{t('chat.portal.activeAgent')}</p>
          <div className={cn(
            'flex items-center gap-3 rounded-xl border p-3',
            dark ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-zinc-50',
          )}>
            <div className={cn('rounded-lg bg-gradient-to-tr p-2 text-white', visual.color)}>
              <AgentIcon className="h-4 w-4" />
            </div>
            <div className="truncate">
              <h4 className={cn('text-xs font-bold', dark ? 'text-zinc-200' : 'text-zinc-800')}>
                {displayAgentName(agentId)}
              </h4>
              <p className="truncate text-[10px] text-zinc-400">{visual.tagline}</p>
            </div>
          </div>
        </div>

        <nav className="space-y-1">
          <p className="mb-2 text-[9px] font-bold uppercase tracking-wider text-zinc-400">{t('chat.portal.shortcuts')}</p>
          <SideNavButton
            active={activeTab === 'chat'}
            dark={dark}
            icon={<MessageSquare className="h-4 w-4" />}
            label={t('chat.portal.chat')}
            onClick={onChat}
          />
          <SideNavButton
            active={activeTab === 'explore'}
            dark={dark}
            icon={<Compass className="h-4 w-4" />}
            label={t('chat.portal.explore')}
            onClick={onExplore}
          />
          <SideNavButton
            active={false}
            dark={dark}
            icon={<Plus className="h-4 w-4" />}
            label={t('chat.portal.newConversation')}
            onClick={onNew}
          />
        </nav>
      </div>

      <div className="space-y-3">
        <div className={cn('flex items-center justify-between gap-2 border-t pt-4', dark ? 'border-zinc-800' : 'border-zinc-200')}>
          <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">{t('chat.portal.language')}</p>
          <button
            type="button"
            onClick={onToggleLang}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
              dark ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800' : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100',
            )}
            aria-label={t('chat.portal.language')}
          >
            <Languages className="h-3.5 w-3.5" />
            {lang === 'zh' ? t('lang.zh') : t('lang.en')}
          </button>
        </div>
        <div className={cn('flex items-center gap-3', dark ? 'border-zinc-800' : 'border-zinc-200')}>
          <div className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full',
            dark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-600',
          )}>
            <User className="h-4 w-4" />
          </div>
          <div>
            <h4 className={cn('text-xs font-bold', dark ? 'text-zinc-200' : 'text-zinc-800')}>Agim</h4>
            <p className="text-[9px] font-semibold uppercase tracking-wider text-teal-500">
              {status === 'open' ? t('chat.portal.connected') : status}
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

function SideNavButton(props: {
  active: boolean
  dark: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}): JSX.Element {
  const { active, dark, icon, label, onClick } = props
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl p-2.5 text-xs font-semibold transition-all',
        active
          ? (dark ? 'bg-zinc-800 text-teal-400' : 'bg-zinc-100 text-teal-600')
          : (dark ? 'text-zinc-400 hover:bg-zinc-900' : 'text-zinc-600 hover:bg-zinc-50'),
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
