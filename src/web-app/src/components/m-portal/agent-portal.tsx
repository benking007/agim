/**
 * Agent Portal — mobile chat surface matching the ChatGPT Mobile design
 * prototype (docs/design/chatgpt_mobile_design_prototype.tsx) at visual parity.
 *
 * Transport: existing useChat() WebSocket — not the prototype's Gemini mock.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp, Bot, ChevronDown, ChevronRight, Compass, Languages, Menu, MessageSquare,
  Mic, Moon, Plus, Search, Sparkles, Square, Sun, User, X,
} from 'lucide-react'
import { toast } from 'sonner'

import { useChat, type ChatMessage } from '@/hooks/use-chat'
import { useIosViewportZoomReset } from '@/hooks/use-ios-viewport-zoom-reset'
import { ApprovalDock } from '@/components/chat/approval-dock'
import { AskDock } from '@/components/chat/ask-dock'
import { MarkdownView } from '@/components/chat/markdown-view'
import { MessageActions } from '@/components/chat/message-actions'
import { usePrefs, type Lang, type ThemeMode } from '@/stores/prefs'
import { cn } from '@/lib/utils'
import { agentVisual, displayAgentName } from './agent-visuals'
import { PortalPet } from './portal-pet'
import { PortalRunStatus } from './portal-run-status'
import { VoiceOverlay } from './voice-overlay'

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

  const { state, send, stop, switchAgent, approvalClick, choiceSubmit, newConversation } = useChat()
  useIosViewportZoomReset()
  const [activeTab, setActiveTab] = useState<Tab>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [showVoiceOverlay, setShowVoiceOverlay] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [exploreCategory, setExploreCategory] = useState<(typeof EXPLORE_CATS)[number]>('All')
  const [inputMessage, setInputMessage] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const agentId = state.agent || state.agents[0] || 'agim'
  const visual = agentVisual(agentId)
  const AgentIcon = visual.icon
  const isTyping = state.currentReplyId != null
  const demoWidth = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === 'width'
  const chatMessages = useMemo(
    () => (demoWidth ? widthDemoMessages() : state.messages.filter((m) => !m.approval)),
    [demoWidth, state.messages],
  )
  const chatTurns = useMemo(() => groupChatTurns(chatMessages), [chatMessages])
  const currentReplyInList = chatMessages.some((m) => m.id === state.currentReplyId)
  // Fallback only when the placeholder message has not landed yet.
  const streamingFallback = isTyping && !currentReplyInList
  const canStop = isTyping || state.activeRunId != null

  // Lock document scroll so WKWebView / mobile Safari rubber-band the
  // message list only — not the whole portal chrome.
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('agim-portal-lock')
    return () => {
      root.classList.remove('agim-portal-lock')
    }
  }, [])

  // Scroll on new messages / streaming — intentional broad deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when transcript grows or streams
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages.length, chatMessages[chatMessages.length - 1]?.content, isTyping, chatMessages[chatMessages.length - 1]?.activity?.steps.length])

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

  function onSend(e?: FormEvent): void {
    e?.preventDefault()
    const text = inputMessage.trim()
    if (!text) return
    if (state.status !== 'open') {
      toast.error('Not connected')
      return
    }
    setInputMessage('')
    send(text)
  }

  function selectAgent(id: string): void {
    switchAgent(id)
    setActiveTab('chat')
    setShowModelDropdown(false)
    setSidebarOpen(false)
  }

  const dark = theme === 'dark'

  return (
    <div className={cn(
      'relative flex h-dvh flex-col overflow-hidden font-sans selection:bg-teal-500/30',
      dark ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-100 text-zinc-900',
    )}>
      {/* Main surface — fully blurred while the sidebar is open */}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col transition-[filter,opacity] duration-300',
          sidebarOpen && 'pointer-events-none select-none blur-[6px] brightness-75',
        )}
        aria-hidden={sidebarOpen || undefined}
      >
      <header className={cn(
        'sticky top-0 z-30 flex shrink-0 items-center justify-between border-b px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] transition-all',
        dark ? 'border-zinc-900 bg-zinc-950 text-white' : 'border-zinc-200 bg-white text-zinc-800',
      )}>
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className={cn('rounded-lg p-1.5 transition', dark ? 'hover:bg-zinc-900' : 'hover:bg-zinc-100')}
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
      {activeTab === 'chat' && (
        <div className={cn(
          // pt-0 so sticky user chips sit flush under the header (no py gap when pinned).
          // pb leaves room for composer + perched pet.
          'min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pt-0 pb-40 transition-colors duration-300 scrollbar-none',
          dark ? 'bg-zinc-950' : 'bg-zinc-100',
        )}>
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
                  className={cn(
                    // Sticky topic chip — rounded rect (not a full pill/ellipse)
                    'sticky top-0 z-10 w-full rounded-xl border px-4 py-3 text-left text-[13px] font-medium leading-relaxed',
                    dark
                      ? 'border-zinc-700 bg-zinc-800 text-zinc-100'
                      : 'border-zinc-200 bg-white text-zinc-900',
                  )}
                >
                  {turn.user.content}
                </div>
              )}
              {turn.replies.map((msg) => (
                <div
                  key={msg.id}
                  // AI reply column — slightly inset vs the full-width user
                  // chip, centered (equal left/right gap). min-w-0 so wide
                  // tables cannot expand past the cap.
                  className="mx-auto flex w-[92%] max-w-[92%] min-w-0 flex-col self-center overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300"
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
                        'min-w-0 select-text break-words text-[13px] leading-relaxed',
                        dark ? 'text-zinc-200' : 'text-zinc-800',
                      )}>
                        <MarkdownView
                          content={msg.content}
                          className="break-words text-[13px] leading-relaxed"
                        />
                        {!(isTyping && msg.id === state.currentReplyId) && (
                          <MessageActions content={msg.content} dark={dark} />
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {streamingFallback && (
            <div className="mx-auto w-[88%] max-w-[88%] min-w-0 self-center" data-testid="portal-ai-reply-streaming">
              <PortalRunStatus
                dark={dark}
                agentName={displayAgentName(agentId)}
                agentColor={visual.color}
                AgentIcon={AgentIcon}
                streaming
              />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Explore */}
      {activeTab === 'explore' && (
        <div className={cn(
          'min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-4 py-5 pb-8 transition-colors duration-300 scrollbar-none',
          dark ? 'bg-zinc-950' : 'bg-zinc-100',
        )}>
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
      )}

      {/* Docks + composer */}
      {activeTab === 'chat' && (
        <div className={cn(
          'absolute inset-x-0 bottom-0 z-20 px-4 pt-8 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
          dark ? 'bg-gradient-to-t from-zinc-950 via-zinc-950/95 to-transparent' : 'bg-gradient-to-t from-zinc-100 via-zinc-100/95 to-transparent',
        )}>
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
              busy={canStop}
              // Sink ~30% of the h-11 pet behind the composer (0.3 × 2.75rem ≈ 0.85rem).
              className="absolute bottom-[calc(100%-0.85rem)] right-1 z-0"
            />
            <form
              onSubmit={onSend}
              className={cn(
                'relative z-10 flex items-center justify-between rounded-[26px] border p-1.5 shadow-lg transition-all focus-within:border-teal-500',
                dark ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-white',
              )}
            >
              <button
                type="button"
                className={cn(
                  'rounded-full p-2 text-zinc-400 transition-colors',
                  dark ? 'hover:bg-zinc-800 hover:text-teal-400' : 'hover:bg-zinc-100 hover:text-teal-600',
                )}
                onClick={() => newConversation()}
                aria-label={t('chat.portal.newConversation')}
              >
                <Plus className="h-4 w-4" />
              </button>
              <input
                type="text"
                placeholder={t('chat.portal.messagePlaceholder', { agent: displayAgentName(agentId) })}
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                className={cn(
                  // text-md = 16px (theme text-base is 15px). iOS Safari auto-zooms
                  // focused inputs under 16px — same fix as ChatComposer.
                  'flex-1 bg-transparent px-3 py-1 text-md focus:outline-none',
                  dark ? 'text-zinc-200 placeholder:text-zinc-500' : 'text-zinc-800 placeholder:text-zinc-400',
                )}
              />
              <div className="flex items-center gap-1">
                {inputMessage.trim() && !canStop ? (
                  <button
                    type="submit"
                    className={cn(
                      'rounded-full p-2 shadow-md transition-all',
                      dark ? 'bg-zinc-100 text-zinc-950 hover:bg-white' : 'bg-zinc-900 text-zinc-100 hover:bg-black',
                    )}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                ) : canStop ? (
                  <button
                    type="button"
                    onClick={() => stop()}
                    className={cn(
                      'rounded-full p-2 shadow-md transition-all',
                      dark ? 'bg-zinc-100 text-zinc-950 hover:bg-white' : 'bg-zinc-900 text-zinc-100 hover:bg-black',
                    )}
                    title={t('chat.portal.stop')}
                    aria-label={t('chat.portal.stop')}
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowVoiceOverlay(true)}
                    className={cn(
                      'rounded-full p-2 text-zinc-400 transition-colors',
                      dark ? 'hover:bg-zinc-800 hover:text-teal-400' : 'hover:bg-zinc-100 hover:text-teal-600',
                    )}
                    title={t('chat.portal.voice')}
                  >
                    <Mic className="h-4 w-4" />
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
      </div>

      {/* Sidebar sheet over the blurred main surface */}
      {sidebarOpen && (
        <div className="absolute inset-0 z-40">
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
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-teal-500">
                  <Sparkles className="h-5 w-5" />
                  <span className="text-sm">{t('chat.portal.brand')}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSidebarOpen(false)}
                  className={cn('rounded-full p-1.5 transition', dark ? 'text-zinc-400 hover:bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-100')}
                >
                  <X className="h-4 w-4" />
                </button>
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
                  onClick={() => { setActiveTab('chat'); setSidebarOpen(false) }}
                />
                <SideNavButton
                  active={activeTab === 'explore'}
                  dark={dark}
                  icon={<Compass className="h-4 w-4" />}
                  label={t('chat.portal.explore')}
                  onClick={() => { setActiveTab('explore'); setSidebarOpen(false) }}
                />
                <SideNavButton
                  active={false}
                  dark={dark}
                  icon={<Plus className="h-4 w-4" />}
                  label={t('chat.portal.newConversation')}
                  onClick={() => { newConversation(); setSidebarOpen(false); setActiveTab('chat') }}
                />
              </nav>
            </div>

            <div className="space-y-3">
              <div className={cn('flex items-center justify-between gap-2 border-t pt-4', dark ? 'border-zinc-800' : 'border-zinc-200')}>
                <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">{t('chat.portal.language')}</p>
                <button
                  type="button"
                  onClick={toggleLang}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
                    dark ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800' : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100',
                  )}
                  aria-label={t('chat.portal.language')}
                >
                  <Languages className="h-3.5 w-3.5" />
                  {prefs.lang === 'zh' ? t('lang.zh') : t('lang.en')}
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
                    {state.status === 'open' ? t('chat.portal.connected') : state.status}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showVoiceOverlay && (
        <VoiceOverlay theme={theme} agentId={agentId} onClose={() => setShowVoiceOverlay(false)} />
      )}
    </div>
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
