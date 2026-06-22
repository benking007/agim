// agim TUI v1.2.77 — opencode-parity iteration.
//
// Added in this iteration (vs v1.2.76):
//   * !cmd  — inline bash escape; runs in cwd, output as system message
//   * @file — fuzzy file picker popup (cwd-relative; replaces @<token>
//             with the resolved path)
//   * /editor — open $EDITOR (vi fallback) for multi-line composition
//   * /compact — ask the current agent to summarise history, then
//                replace history with the summary
//   * /redo /undo — replay last prompt / drop last turn
//   * /export — dump conversation to ./agim-tui-<timestamp>.md
//   * ctrl+p  — global command palette (slash + actions, fuzzy)
//   * completion bell — write \x07 on assistant reply finish (off via
//                       IMHUB_TUI_NO_BELL=1)
//   * markdown rendering for assistant replies (paragraphs, headings,
//                       lists, code blocks with naive keyword colour,
//                       inline code, bold/italic, blockquotes)
//
// Still deferred: multi-line raw editor in-place, image attach, multi-
// session list, remote-daemon client mode.

import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import { spawnSync, exec as cpExec } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { registry } from '../../core/registry.js'
import { logger as rootLogger } from '../../core/logger.js'
import type { ChatMessage as AgentChatMessage } from '../../core/types.js'
import { Markdown } from './markdown.js'
import { generateSessionId, listSessions, saveSession, type StoredMessage } from './sessions.js'
import type {
  TuiApprovalBridge,
  TuiApprovalView,
  TuiAskView,
} from './approval-bridge.js'
import {
  approvalActionsFor,
  toApprovalStatusLine,
  type TuiApprovalAction,
  type TuiApprovalStatusLine,
} from './approval-view.js'

const log = rootLogger.child({ component: 'tui' })

export interface ChatMessage {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  pending?: boolean
  elapsedMs?: number
  agentName?: string
}

let messageSeq = 0
function nextMessageId(): string {
  messageSeq += 1
  return `tui-msg-${Date.now().toString(36)}-${messageSeq.toString(36)}`
}
function withMessageId(message: ChatMessage): ChatMessage {
  return message.id ? message : { ...message, id: nextMessageId() }
}
function withMessageIds(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(withMessageId)
}

/** Compact token count: 1234 → 1.2k, 1_200_000 → 1.2M. */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function shortSessionId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 14)}…`
}

interface SlashCommand {
  name: string
  description: string
  takesArg?: boolean
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/agents',  description: '列出已注册的 agent' },
  { name: '/agent',   description: '切换 agent — 例：/agent codex', takesArg: true },
  { name: '/new',     description: '创建新会话（清空当前聊天历史）' },
  { name: '/sessions', description: '查看最近会话（可配合 --resume）' },
  { name: '/editor',  description: '调外部 $EDITOR 写长 prompt（vi 兜底）' },
  { name: '/compact', description: '请 agent 摘要历史并把摘要作为新起点' },
  { name: '/redo',    description: '重新发送上一条用户消息' },
  { name: '/undo',    description: '撤回最近一轮（用户 + 回复）' },
  { name: '/export',  description: '把对话导出到 ./agim-tui-<时间>.md' },
  { name: '/clear',   description: '清空当前对话历史' },
  { name: '/help',    description: '显示帮助信息' },
  { name: '/exit',    description: '退出 TUI（同 /quit）' },
  { name: '/quit',    description: '退出 TUI' },
]

interface FileEntry { rel: string; isDir: boolean }

// Lightweight scan of cwd — first ~2000 entries, ignore typical heavy
// dirs. Sync because we run it on demand from a keystroke; OK for
// reasonable repo sizes. Hidden files / node_modules / .git skipped.
function scanFiles(root: string, max = 2000): FileEntry[] {
  const out: FileEntry[] = []
  const stack: string[] = ['.']
  const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.cache', 'target', 'venv', '__pycache__'])
  while (stack.length > 0 && out.length < max) {
    const cur = stack.pop()!
    const abs = join(root, cur)
    let entries: import('node:fs').Dirent[] = []
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const rel = cur === '.' ? e.name : join(cur, e.name)
      if (e.isDirectory()) {
        out.push({ rel: rel + sep, isDir: true })
        stack.push(rel)
      } else if (e.isFile()) {
        out.push({ rel, isDir: false })
      }
      if (out.length >= max) break
    }
  }
  return out
}

interface AppProps {
  initialAgent?: string
  /** Resume from disk; overrides initial empty state. */
  resumed?: { id: string; agent?: string; messages: ChatMessage[]; createdAt?: string; agentSessions?: Record<string, string> }
  /** Stable session id — generated upstream and printed on exit so
   *  user can `agim tui --resume <id>` next time. */
  sessionId: string
  /** Notify entry so exit hint prints the latest in-app session id. */
  onSessionIdChange?: (id: string) => void
  /** In-process approval surface used by `agim tui` for tool-call approvals. */
  approvalBridge?: TuiApprovalBridge
}

interface PaletteItem {
  id: string
  name: string
  description: string
  takesArg?: boolean
  action?: 'help'
}

// Memoized chat history — input keystrokes change `input` state on
// the parent but NOT `messages`. Memo cuts the per-keystroke React
// reconciliation cost in half by short-circuiting this subtree when
// messages identity hasn't changed, which removes the visible flicker
// on long histories.
interface ChatHistoryProps {
  messages: ChatMessage[]
  agent: string | undefined
  chatWidth: number
}
const ChatHistory = React.memo(function ChatHistory({ messages, agent, chatWidth }: ChatHistoryProps): JSX.Element {
  if (messages.length === 0) {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>(空) 输入消息开始对话 · / 唤出命令 · ! 行内 shell · @ 引用文件 · Ctrl-P 命令面板</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {messages.map((m) => (
        <Box key={m.id} flexDirection="column" marginBottom={1} width={chatWidth}>
          <Text>
            {m.role === 'user' && <Text color="cyan" bold>你 </Text>}
            {m.role === 'assistant' && <Text color="magenta" bold>{m.agentName || agent || 'agent'} </Text>}
            {m.role === 'system' && <Text color="yellow" bold>系统 </Text>}
            {m.pending && <Text dimColor>· 生成中…（Esc 取消）</Text>}
          </Text>
          {m.role === 'assistant' && !m.pending
            ? <Markdown source={m.content} />
            : <Text>{m.content || (m.pending ? '…' : '')}</Text>}
          {m.role === 'assistant' && !m.pending && m.elapsedMs !== undefined && (
            <Text dimColor>■ {m.agentName || agent} · {(m.elapsedMs / 1000).toFixed(1)}s</Text>
          )}
        </Box>
      ))}
    </Box>
  )
})

function askChoiceLabel(label: string): string {
  return label.replace(/^\d+\.\s*/, '').trim()
}

function ApprovalDock({ approval, selectedIndex, actions }: {
  approval: TuiApprovalView
  selectedIndex: number
  actions: readonly TuiApprovalAction[]
}): JSX.Element {
  const preview = approval.prompt.inputJson.length > 600
    ? `${approval.prompt.inputJson.slice(0, 600)}…`
    : approval.prompt.inputJson
  const autoAllowMode = approval.prompt.mode === 'auto-allow'
  const hasSingleDeny = autoAllowMode && actions.length === 1
  if (hasSingleDeny) {
    const deny = actions[0]
    return (
      <Box borderStyle="single" borderColor="yellow" paddingX={1} marginX={1} marginTop={1}>
        <Text>
          <Text bold color="yellow">默认放行命中 </Text>
          <Text>{approval.prompt.toolName}</Text>
          <Text dimColor> · 仅在你拒绝时中断执行</Text>
        </Text>
        <Text dimColor>{preview}</Text>
        <Text>
          <Text color={deny.color} inverse={selectedIndex === 0} bold={selectedIndex === 0}>
            {selectedIndex === 0 ? `› ${deny.label}` : `  ${deny.label}`}
          </Text>
          <Text dimColor> · Enter 立即拒绝 · 仍兼容 n 快捷输入</Text>
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1} marginX={1} marginTop={1}>
      <Text>
        <Text bold color="yellow">审批请求 </Text>
        <Text>{approval.prompt.toolName}</Text>
      </Text>
      <Text dimColor>{preview}</Text>
      <Box flexDirection="column">
        <Box>
          {actions.map((action, index) => (
            <Text key={action.choice}>
              <Text
                color={action.color}
                inverse={index === selectedIndex}
                bold={index === selectedIndex}
              >
                {index === selectedIndex ? `› ${action.label} ` : `  ${action.label} `}
              </Text>
              <Text> </Text>
            </Text>
          ))}
        </Box>
        <Text dimColor>↑↓/←→/Tab 选择 · Enter 确认 · 仍兼容 y / n / all 快捷输入</Text>
      </Box>
    </Box>
  )
}

function ApprovalStatusBar({ status }: { status: TuiApprovalStatusLine }): JSX.Element {
  return (
    <Box paddingX={1}>
      <Text>
        <Text dimColor>审批状态 · {status.toolName} · </Text>
        <Text color={status.color}>{status.label}</Text>
      </Text>
    </Box>
  )
}

function AskDock({
  ask,
  selectedIndex,
  selectedMulti,
  customInputMode,
}: {
  ask: TuiAskView
  selectedIndex: number
  selectedMulti: number[]
  customInputMode: boolean
}): JSX.Element {
  const hasCustomOption = ask.prompt.choices.some((choice) => choice.data.endsWith(':custom'))
  const options = [...ask.prompt.choices]
  if (ask.allowCustomInput && !hasCustomOption) {
    options.push({
      label: `0. ${ask.customInputLabel}`,
      data: `ask:${ask.reqId}:custom`,
    })
  }
  const selectedSet = new Set(selectedMulti)
  const maxIndex = Math.max(0, options.length - 1)
  const safeIndex = Math.min(selectedIndex, maxIndex)

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={ask.finalText ? 'gray' : 'cyan'} paddingX={1} marginX={1} marginTop={1}>
      <Text>
        <Text bold color={ask.finalText ? 'gray' : 'cyan'}>用户决策 </Text>
        <Text>{ask.prompt.title || '请选择'}</Text>
        <Text dimColor> · {ask.selectionMode === 'multi' ? `多选 ${ask.minSelections}-${ask.maxSelections}` : '单选'}</Text>
      </Text>
      <Text dimColor>{ask.prompt.body}</Text>
      {ask.finalText ? (
        <Text color="green">✓ {ask.finalText}</Text>
      ) : customInputMode ? (
        <Text color="yellow">输入自定义回复后按 Enter 提交（Esc 返回选项）</Text>
      ) : (
        <Box flexDirection="column">
          {options.map((choice, index) => {
            const isCustom = choice.data.endsWith(':custom')
            const display = askChoiceLabel(choice.label)
            const selected = ask.selectionMode === 'multi' && !isCustom ? selectedSet.has(index + 1) : false
            return (
              <Text
                key={`${choice.data}-${choice.label}`}
                inverse={index === safeIndex}
                color={index === safeIndex ? 'cyan' : (selected ? 'green' : undefined)}
              >
                {ask.selectionMode === 'multi' && !isCustom ? (selected ? '[x] ' : '[ ] ') : '    '}
                {index === safeIndex ? '› ' : '  '}
                {display}
                {isCustom ? ' (自定义输入)' : ''}
              </Text>
            )
          })}
          <Text dimColor>
            {ask.selectionMode === 'multi'
              ? '↑↓/Tab 选择 · Space 勾选 · Enter 提交'
              : '↑↓/Tab 选择 · Enter 确认'}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export function TuiApp({ initialAgent, resumed, sessionId, onSessionIdChange, approvalBridge }: AppProps): JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { setRawMode } = useStdin()

  const [agent, setAgent] = useState<string | undefined>(resumed?.agent ?? initialAgent)
  const [messages, setMessages] = useState<ChatMessage[]>(() => withMessageIds(resumed?.messages ?? []))
  const [activeSessionId, setActiveSessionId] = useState<string>(resumed?.id ?? sessionId)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [popupIndex, setPopupIndex] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  const [palette, setPalette] = useState<{ open: boolean; query: string; index: number }>({ open: false, query: '', index: 0 })
  const [agentSessions, setAgentSessions] = useState<Record<string, string>>(() => ({ ...(resumed?.agentSessions ?? {}) }))
  const abortRef = useRef<AbortController | null>(null)
  const filesCacheRef = useRef<FileEntry[] | null>(null)
  const agentSessionsRef = useRef<Record<string, string>>(agentSessions)
  const inputHistoryRef = useRef<string[]>([])
  const historyCursorRef = useRef<number>(-1)
  const historyDraftRef = useRef<string>('')
  // Cumulative usage this TUI session (fed by sendPrompt's onUsage). Agim Agent
  // emits all three; some adapters emit only cost — we accumulate what's there.
  const [usage, setUsage] = useState<{ inTok: number; outTok: number; costUsd: number }>({ inTok: 0, outTok: 0, costUsd: 0 })
  const [approval, setApproval] = useState<TuiApprovalView | null>(null)
  const [approvalStatusLine, setApprovalStatusLine] = useState<TuiApprovalStatusLine | null>(null)
  const [approvalActionIndex, setApprovalActionIndex] = useState(0)
  const [ask, setAsk] = useState<TuiAskView | null>(null)
  const [askActionIndex, setAskActionIndex] = useState(0)
  const [askSelectedIndexes, setAskSelectedIndexes] = useState<number[]>([])
  const [askCustomInputMode, setAskCustomInputMode] = useState(false)
  const approvalReqId = approval?.prompt.reqId
  const approvalOutcome = approval?.outcome
  const askPending = Boolean(ask && !ask.finalText)
  const activeApprovalPending = Boolean(approvalReqId && !approvalOutcome)
  const activeDecisionPending = askPending || activeApprovalPending
  const approvalActions = useMemo(() => approvalActionsFor(approval), [approval])
  const approvalActionSafeIndex = Math.max(0, Math.min(approvalActionIndex, approvalActions.length - 1))

  useEffect(() => {
    agentSessionsRef.current = agentSessions
  }, [agentSessions])

  useEffect(() => {
    onSessionIdChange?.(activeSessionId)
  }, [activeSessionId, onSessionIdChange])

  useEffect(() => {
    if (!approvalBridge) return
    approvalBridge.setSession(activeSessionId)
    const unsubscribeApproval = approvalBridge.subscribe((next) => {
      if (next?.outcome) {
        const status = toApprovalStatusLine(next)
        if (status) setApprovalStatusLine(status)
        setApproval(null)
        return
      }
      if (next) {
        setApprovalActionIndex(0)
        setApprovalStatusLine(null)
      }
      setApproval(next)
    })
    const unsubscribeAsk = approvalBridge.subscribeAsk((next) => {
      if (next && !next.finalText) {
        setAskActionIndex(0)
        setAskSelectedIndexes([])
        setAskCustomInputMode(false)
      }
      setAsk(next)
    })
    return () => {
      unsubscribeApproval()
      unsubscribeAsk()
    }
  }, [approvalBridge, activeSessionId])

  const cwd = useMemo(() => {
    const home = process.env.HOME
    const c = process.cwd()
    return home && c.startsWith(home) ? '~' + c.slice(home.length) : c
  }, [])

  const cols = stdout?.columns ?? 80
  const chatWidth = Math.min(cols - 4, 120)
  const currentAgentSession = agent ? agentSessions[agent] : undefined
  const askOptions = useMemo(() => {
    if (!ask) return [] as Array<{ label: string; data: string; index: number; isCustom: boolean }>
    const base = ask.prompt.choices.map((choice, i) => ({
      label: choice.label,
      data: choice.data,
      index: i + 1,
      isCustom: choice.data.endsWith(':custom'),
    }))
    if (ask.allowCustomInput && !base.some((item) => item.isCustom)) {
      base.push({
        label: `0. ${ask.customInputLabel}`,
        data: `ask:${ask.reqId}:custom`,
        index: base.length + 1,
        isCustom: true,
      })
    }
    return base
  }, [ask])

  // ── Slash-command popup state ─────────────────────────────────────
  const slashPopupOpen = input.startsWith('/') && !input.includes(' ')
  const filteredSlash = useMemo(() => {
    if (!slashPopupOpen) return [] as SlashCommand[]
    const q = input.toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
  }, [input, slashPopupOpen])

  // ── @file picker state (inline trigger) ───────────────────────────
  // We look for the LAST `@token` (token = no whitespace) in the
  // current input. If it exists and is being actively typed, show the
  // file picker filtered by the token's tail.
  const fileTokenMatch = useMemo(() => {
    const m = /(^|\s)@([^\s@]*)$/.exec(input)
    return m ? { start: m.index + m[1].length, query: m[2] } : null
  }, [input])
  const filePopupOpen = !slashPopupOpen && fileTokenMatch !== null
  const filteredFiles = useMemo(() => {
    if (!filePopupOpen || !fileTokenMatch) return [] as FileEntry[]
    if (!filesCacheRef.current) filesCacheRef.current = scanFiles(process.cwd())
    const q = fileTokenMatch.query.toLowerCase()
    if (!q) return filesCacheRef.current.slice(0, 15)
    return filesCacheRef.current
      .filter((f) => f.rel.toLowerCase().includes(q))
      .slice(0, 15)
  }, [filePopupOpen, fileTokenMatch])

  // ── /agent <name> argument completion ─────────────────────────────
  // Once a space follows /agent the slash popup closes; this picks up the
  // partial agent name and completes it from the live registry.
  const agentArgMatch = useMemo(() => {
    const m = /^\/agent\s+(\S*)$/.exec(input)
    return m ? { query: m[1] } : null
  }, [input])
  const agentArgPopupOpen = !slashPopupOpen && !filePopupOpen && agentArgMatch !== null
  const filteredAgentArgs = useMemo(() => {
    if (!agentArgPopupOpen || !agentArgMatch) return [] as string[]
    const all = registry.listAgents()
    const q = agentArgMatch.query.toLowerCase()
    return (q ? all.filter((a) => a.toLowerCase().includes(q)) : all).slice(0, 15)
  }, [agentArgPopupOpen, agentArgMatch])

  const popupResetKey = `${filteredSlash.length}:${filteredFiles.length}:${filteredAgentArgs.length}`
  useEffect(() => {
    if (popupResetKey) setPopupIndex(0)
  }, [popupResetKey])

  // ── Command palette (ctrl+p) ──────────────────────────────────────
  const paletteItems = useMemo((): PaletteItem[] => {
    const base = SLASH_COMMANDS.map((c) => ({
      id: `slash:${c.name}`,
      name: c.name,
      description: c.description,
      takesArg: c.takesArg,
    }))
    return [
      ...base,
      { id: 'action:help', name: '快捷键帮助', description: '打开帮助浮层（?）', action: 'help' },
      { id: 'action:new', name: '新建会话', description: '立即执行 /new（清空历史并生成新会话）' },
      { id: 'action:sessions', name: '最近会话', description: '立即执行 /sessions（查看最近会话）' },
    ]
  }, [])

  const filteredPalette = useMemo(() => {
    if (!palette.open) return [] as PaletteItem[]
    const q = palette.query.toLowerCase().trim()
    if (!q) return paletteItems
    return paletteItems.filter((c) =>
      c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    )
  }, [palette, paletteItems])

  useInput((inputCh, key) => {
    // Ctrl-P opens / closes the command palette regardless of mode.
    if (key.ctrl && inputCh === 'p') {
      setHelpOpen(false)
      setPalette((p) => ({ open: !p.open, query: '', index: 0 }))
      return
    }

    const popupOpen = slashPopupOpen || filePopupOpen || agentArgPopupOpen
    if (askPending && !palette.open && !helpOpen && !popupOpen && ask) {
      if (!askCustomInputMode) {
        if (key.leftArrow || key.upArrow) {
          setAskActionIndex((index) => (index - 1 + askOptions.length) % Math.max(askOptions.length, 1))
          return
        }
        if (key.rightArrow || key.downArrow || key.tab) {
          setAskActionIndex((index) => (index + 1) % Math.max(askOptions.length, 1))
          return
        }
        if (key.escape && ask.allowCustomInput) {
          setAskCustomInputMode(false)
          return
        }
        if (key.return) {
          const pick = askOptions[askActionIndex]
          if (!pick) return
          if (pick.isCustom) {
            setAskCustomInputMode(true)
            setInput('')
            return
          }
          if (ask.selectionMode === 'multi') {
            const picks = askSelectedIndexes.length > 0
              ? askSelectedIndexes
              : [pick.index]
            if (picks.length < ask.minSelections || picks.length > ask.maxSelections) {
              setError(`请先选择 ${ask.minSelections}-${ask.maxSelections} 项`)
              return
            }
            void approvalBridge?.submitAskMulti(picks).then((handled) => {
              if (handled) {
                setInput('')
                setAskCustomInputMode(false)
                setAskSelectedIndexes([])
              }
            })
            return
          }
          void approvalBridge?.submitAskSingle(pick.index).then((handled) => {
            if (handled) {
              setInput('')
              setAskCustomInputMode(false)
              setAskSelectedIndexes([])
            }
          })
          return
        }
        if (ask.selectionMode === 'multi' && inputCh === ' ') {
          const pick = askOptions[askActionIndex]
          if (!pick || pick.isCustom) return
          setAskSelectedIndexes((prev) => {
            if (prev.includes(pick.index)) return prev.filter((n) => n !== pick.index)
            if (prev.length >= ask.maxSelections) {
              setError(`最多选择 ${ask.maxSelections} 项`)
              return prev
            }
            return [...prev, pick.index].sort((a, b) => a - b)
          })
          return
        }
      } else if (key.escape) {
        setAskCustomInputMode(false)
        setInput('')
        return
      }
    }
    if (activeApprovalPending && !askPending && !palette.open && !helpOpen && !popupOpen && approval) {
      const actionCount = Math.max(approvalActions.length, 1)
      if ((key.leftArrow || key.upArrow) && actionCount > 1) {
        setApprovalActionIndex((index) => (index - 1 + actionCount) % actionCount)
        return
      }
      if ((key.rightArrow || key.downArrow || key.tab) && actionCount > 1) {
        setApprovalActionIndex((index) => (index + 1) % actionCount)
        return
      }
      if (key.return) {
        const action = approvalActions[approvalActionSafeIndex] ?? approvalActions[0]
        if (action) {
          void approvalBridge?.submitChoice(action.choice).then((handled) => {
            if (handled) setInput('')
          })
        }
        return
      }
    }

    // `?` toggles the help overlay when the prompt box is empty so users
    // can discover keys without `/help` being pushed away by chat history.
    if (!key.ctrl && !key.meta && inputCh === '?' && !palette.open && !popupOpen && input.trim().length === 0) {
      setHelpOpen((h) => !h)
      return
    }

    if (helpOpen) {
      if (key.escape || key.return || inputCh === '?') setHelpOpen(false)
      return
    }

    if (palette.open) {
      if (key.escape) {
        setPalette({ open: false, query: '', index: 0 })
        return
      }
      if (key.upArrow) {
        setPalette((p) => ({ ...p, index: (p.index - 1 + filteredPalette.length) % Math.max(filteredPalette.length, 1) }))
        return
      }
      if (key.downArrow) {
        setPalette((p) => ({ ...p, index: (p.index + 1) % Math.max(filteredPalette.length, 1) }))
        return
      }
      if (key.return) {
        const pick = filteredPalette[palette.index]
        if (pick) {
          setPalette({ open: false, query: '', index: 0 })
          if (pick.action === 'help') {
            setHelpOpen(true)
          } else if (pick.takesArg) {
            setInput(pick.name + ' ')
          } else {
            void executeSlashCommand(pick.name)
          }
        }
        return
      }
      if (key.backspace || key.delete) {
        setPalette((p) => ({ ...p, query: p.query.slice(0, -1), index: 0 }))
        return
      }
      // Printable char: append to query.
      if (inputCh && !key.ctrl && !key.meta) {
        setPalette((p) => ({ ...p, query: p.query + inputCh, index: 0 }))
        return
      }
    }

    if (slashPopupOpen && filteredSlash.length > 0) {
      if (key.upArrow) { setPopupIndex((i) => (i - 1 + filteredSlash.length) % filteredSlash.length); return }
      if (key.downArrow) { setPopupIndex((i) => (i + 1) % filteredSlash.length); return }
      if (key.tab) {
        const pick = filteredSlash[popupIndex]
        if (pick) setInput(pick.name + (pick.takesArg ? ' ' : ''))
        return
      }
    }
    if (filePopupOpen && filteredFiles.length > 0 && fileTokenMatch) {
      if (key.upArrow) { setPopupIndex((i) => (i - 1 + filteredFiles.length) % filteredFiles.length); return }
      if (key.downArrow) { setPopupIndex((i) => (i + 1) % filteredFiles.length); return }
      if (key.tab) {
        const pick = filteredFiles[popupIndex]
        if (pick) {
          const before = input.slice(0, fileTokenMatch.start)
          setInput(`${before}@${pick.rel}${pick.isDir ? '' : ' '}`)
        }
        return
      }
    }

    if (agentArgPopupOpen && filteredAgentArgs.length > 0) {
      if (key.upArrow) { setPopupIndex((i) => (i - 1 + filteredAgentArgs.length) % filteredAgentArgs.length); return }
      if (key.downArrow) { setPopupIndex((i) => (i + 1) % filteredAgentArgs.length); return }
      if (key.tab) {
        const pick = filteredAgentArgs[popupIndex]
        if (pick) setInput(`/agent ${pick}`)
        return
      }
    }

    if (!busy && !palette.open && !popupOpen && !activeDecisionPending) {
      if (key.upArrow) {
        const history = inputHistoryRef.current
        if (history.length === 0) return
        if (historyCursorRef.current === -1) historyDraftRef.current = input
        const next = historyCursorRef.current === -1
          ? history.length - 1
          : Math.max(0, historyCursorRef.current - 1)
        historyCursorRef.current = next
        setInput(history[next] ?? '')
        return
      }
      if (key.downArrow) {
        const history = inputHistoryRef.current
        if (history.length === 0 || historyCursorRef.current === -1) return
        const next = historyCursorRef.current + 1
        if (next >= history.length) {
          historyCursorRef.current = -1
          setInput(historyDraftRef.current)
          return
        }
        historyCursorRef.current = next
        setInput(history[next] ?? '')
        return
      }
    }

    if (key.escape && busy && abortRef.current) {
      abortRef.current.abort()
      setBusy(false)
      setMessages((m) => {
        const last = m[m.length - 1]
        if (last && last.role === 'assistant' && last.pending) {
          return [...m.slice(0, -1), { ...last, pending: false, content: last.content + '\n[已取消]' }]
        }
        return m
      })
    }
  })

  useEffect(() => {
    if (agent) return
    const list = registry.listAgents()
    if (list.length > 0) setAgent(list[0])
  }, [agent])

  // v1.2.78 — persist session after each agent turn finishes, so a
  // SIGKILL still preserves the last full exchange.
  const createdAtRef = useRef<string>(resumed?.createdAt ?? new Date().toISOString())
  const persistSnapshot = useCallback((snap: ChatMessage[], curAgent: string | undefined): void => {
    const stored: StoredMessage[] = snap.map((m) => ({
      role: m.role,
      content: m.content,
      elapsedMs: m.elapsedMs,
      agentName: m.agentName,
    }))
    saveSession({
      id: activeSessionId,
      agent: curAgent,
      agentSessions: agentSessionsRef.current,
      cwd: process.cwd(),
      createdAt: createdAtRef.current,
      updatedAt: new Date().toISOString(),
      messages: stored,
    })
  }, [activeSessionId])

  // ── helpers ───────────────────────────────────────────────────────

  const pushSystem = useCallback((content: string): void => {
    setMessages((m) => [...m, withMessageId({ role: 'system', content })])
  }, [])

  async function runBash(cmd: string): Promise<void> {
    setMessages((m) => [...m, withMessageId({ role: 'user', content: '!' + cmd })])
    const startMs = Date.now()
    pushSystem(`▶ shell: ${cmd}`)
    await new Promise<void>((resolve) => {
      cpExec(cmd, { cwd: process.cwd(), timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const ms = Date.now() - startMs
        let body = ''
        if (stdout) body += stdout
        if (stderr) body += (body ? '\n' : '') + '[stderr]\n' + stderr
        if (!body && err) body = `[error] ${err.message}`
        if (!body) body = '(空输出)'
        pushSystem(`\`\`\`\n${body.trim()}\n\`\`\`\n— ${(ms / 1000).toFixed(2)}s · 退出 ${err ? (err.code ?? 1) : 0}`)
        resolve()
      })
    })
  }

  function openEditor(): void {
    const editor = process.env.EDITOR || 'vi'
    let dir: string
    try { dir = mkdtempSync(join(tmpdir(), 'agim-tui-')) } catch (err) {
      setError('无法创建临时文件: ' + (err instanceof Error ? err.message : String(err)))
      return
    }
    const file = join(dir, 'PROMPT.md')
    writeFileSync(file, input || '# 在这里写你的 prompt，保存退出后发送\n# 以 # 开头的行会被忽略\n')
    // Pause Ink's raw-mode while the editor takes the terminal.
    setRawMode?.(false)
    const r = spawnSync(editor, [file], { stdio: 'inherit' })
    setRawMode?.(true)
    if (r.status !== 0 && r.status !== null) {
      setError(`编辑器退出码 ${r.status}`)
      try { unlinkSync(file) } catch { /* ignore */ }
      return
    }
    let body = ''
    try { body = readFileSync(file, 'utf-8') } catch (err) {
      setError('读不到编辑后的内容: ' + (err instanceof Error ? err.message : String(err)))
      return
    } finally {
      try { unlinkSync(file) } catch { /* ignore */ }
    }
    // Strip lines starting with # as "comments" (vi-friendly convention).
    const text = body.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim()
    if (!text) {
      pushSystem('(编辑器内容为空，取消发送)')
      return
    }
    void doSendPrompt(text)
  }

  async function exportTranscript(): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = join(process.cwd(), `agim-tui-${ts}.md`)
    const body = messages.map((m) => {
      const who = m.role === 'user' ? '## 👤 你' : m.role === 'assistant' ? `## 🤖 ${m.agentName || agent || 'agent'}` : '## ⓘ 系统'
      const meta = m.elapsedMs !== undefined ? `\n_${(m.elapsedMs / 1000).toFixed(1)}s_` : ''
      return `${who}\n\n${m.content}${meta}`
    }).join('\n\n---\n\n')
    try {
      writeFileSync(file, `# agim TUI transcript — ${ts}\n\nagent: \`${agent ?? 'none'}\` · cwd: \`${cwd}\`\n\n---\n\n${body}\n`)
      pushSystem(`已导出到 \`${file}\``)
    } catch (err) {
      setError('导出失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  async function doCompact(): Promise<void> {
    if (!agent) { setError('未选择 agent'); return }
    const adapter = registry.findAgent(agent)
    if (!adapter) { setError(`agent ${agent} 不在 registry`); return }
    if (messages.filter((m) => m.role !== 'system').length === 0) {
      pushSystem('(还没有对话内容可以折叠)')
      return
    }
    setBusy(true)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const transcript = messages
        .filter((m) => m.role !== 'system')
        .map((m) => `[${m.role === 'user' ? '用户' : 'agent'}]: ${m.content}`)
        .join('\n\n')
      const prompt = `请把以下对话历史浓缩为 3-5 个要点，保留关键决定 / 数据 / 未解决问题，用中文，仅输出摘要本身不要寒暄：\n\n${transcript}`
      let summary = ''
      for await (const chunk of adapter.sendPrompt(`tui-${process.pid}-compact`, prompt, [], {
        signal: ac.signal,
        onUsage: (d) => setUsage((u) => ({
          inTok: u.inTok + (d.tokensInput ?? 0),
          outTok: u.outTok + (d.tokensOutput ?? 0),
          costUsd: u.costUsd + (d.costUsd ?? 0),
        })),
      })) {
        summary += chunk
      }
      setMessages([withMessageId({ role: 'system', content: '【对话已折叠，以下是摘要】\n\n' + summary.trim() })])
    } catch (err) {
      setError('折叠失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  function doUndo(): void {
    // Drop the last user + assistant pair (keep system messages
    // intact). If the last message is the user-only entry of a still-
    // pending turn, just drop that.
    setMessages((m) => {
      const arr = [...m]
      // Walk from the end, drop until we cut at least one user message.
      while (arr.length > 0) {
        const last = arr.pop()!
        if (last.role === 'user') break
      }
      return arr
    })
  }

  function doRedo(): void {
    // Find the last user message and resend it as a fresh prompt.
    let lastUser: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUser = messages[i].content; break }
    }
    if (!lastUser) { pushSystem('(没有可重发的消息)'); return }
    void doSendPrompt(lastUser)
  }

  function rememberSubmittedLine(text: string): void {
    const normalized = text.trim()
    if (!normalized) return
    const history = inputHistoryRef.current
    if (history[history.length - 1] !== normalized) history.push(normalized)
    if (history.length > 200) history.splice(0, history.length - 200)
    historyCursorRef.current = -1
    historyDraftRef.current = ''
  }

  function showRecentSessions(): void {
    const sessions = listSessions(10, true)
    if (sessions.length === 0) {
      pushSystem('(暂无已保存会话；发送至少一条消息后会自动落盘)')
      return
    }
    const lines = sessions.map((s, i) => {
      const ts = s.updatedAt.replace('T', ' ').slice(0, 19)
      const marker = s.id === activeSessionId ? '★' : ' '
      const ag = s.agent ? ` · ${s.agent}` : ''
      const msg = s.messages > 0 ? ` · ${s.messages} 条` : ''
      return `${String(i + 1).padStart(2, '0')}. ${marker} ${s.id}  ${ts}${ag}${msg}`
    })
    if (!sessions.some((s) => s.id === activeSessionId)) {
      lines.unshift(`00. ★ ${activeSessionId}  (当前会话尚未落盘)`)
    }
    pushSystem(
      `最近会话（★ 当前）：\n${lines.join('\n')}\n\n恢复：agim tui --resume <id>\n自动最近：agim tui --resume last`,
    )
  }

  function startNewSession(): void {
    if (busy) { setError('正在生成中，无法新建会话'); return }
    persistSnapshot(messages, agent)
    const nextId = generateSessionId()
    createdAtRef.current = new Date().toISOString()
    setActiveSessionId(nextId)
    setMessages([withMessageId({ role: 'system', content: `已创建新会话：${nextId}\n提示：上一会话可用 agim tui --resume ${activeSessionId} 恢复` })])
    setUsage({ inTok: 0, outTok: 0, costUsd: 0 })
    setError(null)
    setInput('')
    setHelpOpen(false)
    setPalette({ open: false, query: '', index: 0 })
    setAgentSessions({})
    historyCursorRef.current = -1
    historyDraftRef.current = ''
  }

  async function executeSlashCommand(text: string): Promise<boolean> {
    if (text === '/exit' || text === '/quit') { exit(); return true }
    if (text === '/clear')   { setMessages([]); return true }
    if (text === '/new')     { startNewSession(); return true }
    if (text === '/sessions') { showRecentSessions(); return true }
    if (text === '/redo')    { doRedo(); return true }
    if (text === '/undo')    { doUndo(); return true }
    if (text === '/editor')  { openEditor(); return true }
    if (text === '/compact') { void doCompact(); return true }
    if (text === '/export')  { void exportTranscript(); return true }
    if (text === '/help') {
      setHelpOpen(true)
      pushSystem(
        SLASH_COMMANDS.map((c) => `${c.name.padEnd(10)} ${c.description}`).join('\n')
        + '\n\n键位：Enter 发送 · Esc 取消 · ↑↓ 选项/历史 · Tab 补全 · Ctrl-P 命令面板 · ? 帮助 · Ctrl-C 退出'
        + '\n特殊：!<cmd> 行内 bash · @<file> 文件引用',
      )
      return true
    }
    if (text === '/agents') {
      const list = registry.listAgents()
      pushSystem(list.length === 0 ? '(没有注册 agent)' : `可用：${list.join(', ')}\n当前：${agent ?? '<none>'}`)
      return true
    }
    if (text.startsWith('/agent ')) {
      const next = text.slice('/agent '.length).trim()
      const found = registry.findAgent(next)
      if (!found) { setError(`未找到 agent "${next}"`); return true }
      setAgent(found.name)
      pushSystem(`已切换到 agent: ${found.name}`)
      return true
    }
    if (text.startsWith('/')) {
      pushSystem(`未知命令: ${text}（输入 /help 或 ?）`)
      return true
    }
    return false
  }

  async function doSendPrompt(text: string): Promise<void> {
    if (!agent) { setError('未选择 agent'); return }
    const adapter = registry.findAgent(agent)
    if (!adapter) { setError(`agent ${agent} 不在 registry`); return }

    setError(null)
    setBusy(true)
    const startMs = Date.now()
    // v1.2.84 — pass conversation history so multi-turn context works.
    // Strip system messages (slash output, errors, /agents listings —
    // not agent-relevant) and any in-flight pending assistant turn.
    // `messages` is the value BEFORE the user-prompt append below;
    // React closure captures the pre-update state, which is the
    // history we want to send.
    const history: AgentChatMessage[] = messages
      .filter((m) => m.role !== 'system' && !m.pending && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: new Date(),
      }))

    setMessages((m) => [
      ...m,
      withMessageId({ role: 'user', content: text }),
      withMessageId({ role: 'assistant', content: '', pending: true, agentName: agent }),
    ])

    const currentAgentSessionId = agentSessionsRef.current[agent]
    const ac = new AbortController()
    abortRef.current = ac
    try {
      let chunks = ''
      for await (const chunk of adapter.sendPrompt(`tui-${activeSessionId}`, text, history, {
        agentSessionId: currentAgentSessionId,
        agentSessionResume: Boolean(currentAgentSessionId),
        platform: 'tui',
        channelId: 'local',
        threadId: activeSessionId,
        userId: process.env.USER || 'tui',
        onAgentSessionId: (id) => {
          const normalized = id.trim()
          if (!normalized) return
          setAgentSessions((prev) => {
            if (prev[agent] === normalized) return prev
            const next = { ...prev, [agent]: normalized }
            agentSessionsRef.current = next
            return next
          })
        },
        signal: ac.signal,
        onUsage: (d) => setUsage((u) => ({
          inTok: u.inTok + (d.tokensInput ?? 0),
          outTok: u.outTok + (d.tokensOutput ?? 0),
          costUsd: u.costUsd + (d.costUsd ?? 0),
        })),
      })) {
        chunks += chunk
        setMessages((m) => {
          const last = m[m.length - 1]
          if (!last || last.role !== 'assistant' || !last.pending) return m
          return [...m.slice(0, -1), { ...last, content: chunks }]
        })
      }
      const elapsed = Date.now() - startMs
      setMessages((m) => {
        const last = m[m.length - 1]
        if (!last || last.role !== 'assistant' || !last.pending) return m
        return [...m.slice(0, -1), { ...last, pending: false, elapsedMs: elapsed }]
      })
      // Completion bell — visible (well, audible) cue for sshing-into-
      // box-and-waiting users. Suppressible via env.
      if (process.env.IMHUB_TUI_NO_BELL !== '1') {
        try { process.stdout.write('\x07') } catch { /* ignore */ }
      }
      // Persist after each agent turn so a SIGKILL still preserves
      // the last full exchange. We read the latest state via the
      // setMessages updater pattern to avoid a stale closure.
      setMessages((m) => { persistSnapshot(m, agent); return m })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'tui.sendPrompt.error', err: msg })
      const elapsed = Date.now() - startMs
      setMessages((m) => {
        const last = m[m.length - 1]
        if (!last || last.role !== 'assistant' || !last.pending) return m
        return [
          ...m.slice(0, -1),
          { ...last, pending: false, elapsedMs: elapsed, content: (last.content || '') + `\n\n[错误] ${msg}` },
        ]
      })
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  async function onSubmit(line: string): Promise<void> {
    const text = line.trim()
    if (!text) return

    if (askPending && ask) {
      const handled = askCustomInputMode
        ? await approvalBridge?.submitAskCustom(text)
        : await approvalBridge?.submitAskText(text)
      if (handled) {
        setInput('')
        setAskCustomInputMode(false)
        setAskSelectedIndexes([])
        rememberSubmittedLine(text)
        return
      }
      setError('未识别该回复，请用方向键选择或输入合法选项')
      return
    }

    if (approval && !approval.outcome) {
      const handled = await approvalBridge?.submitText(text)
      if (handled) {
        setInput('')
        rememberSubmittedLine(text)
        return
      }
    }

    if (busy) return

    // Popup auto-accept on Enter when user clearly wants the suggestion.
    if (slashPopupOpen && filteredSlash.length > 0) {
      const exact = filteredSlash.find((c) => c.name === text)
      if (!exact) {
        const pick = filteredSlash[popupIndex]
        if (pick) { setInput(pick.name + (pick.takesArg ? ' ' : '')); return }
      }
    }
    if (filePopupOpen && filteredFiles.length > 0 && fileTokenMatch) {
      const pick = filteredFiles[popupIndex]
      if (pick) {
        const before = input.slice(0, fileTokenMatch.start)
        setInput(`${before}@${pick.rel}${pick.isDir ? '' : ' '}`)
        return
      }
    }
    // /agent: complete the highlighted name first; a 2nd Enter (now exact) submits.
    if (agentArgPopupOpen && filteredAgentArgs.length > 0 && agentArgMatch) {
      if (!filteredAgentArgs.includes(agentArgMatch.query)) {
        const pick = filteredAgentArgs[popupIndex]
        if (pick) { setInput(`/agent ${pick}`); return }
      }
    }

    setInput('')
    rememberSubmittedLine(text)

    // ── Inline bash ────────────────────────────────────────────────
    if (text.startsWith('!')) {
      const cmd = text.slice(1).trim()
      if (!cmd) { pushSystem('(用法: !<shell 命令>)'); return }
      await runBash(cmd)
      return
    }

    // ── Slash commands ─────────────────────────────────────────────
    if (await executeSlashCommand(text)) return

    // Regular prompt path — including @file refs left as raw text;
    // the agent receives the literal `@path/to/file` and can choose to
    // read it via its own tools.
    await doSendPrompt(text)
  }

  // ── render ────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box paddingX={1} flexDirection="column">
        <Text>
          <Text bold color="cyan">agim TUI</Text>
          <Text dimColor>{'  ·  会话 '}</Text>
          <Text color="yellow">{shortSessionId(activeSessionId)}</Text>
          <Text dimColor>{'  ·  agent '}</Text>
          <Text color="green">{agent ?? '<no agent>'}</Text>
          <Text dimColor>{'  ·  '}</Text>
          <Text color={busy ? 'yellow' : 'green'}>{busy ? '生成中' : '就绪'}</Text>
        </Text>
        <Text dimColor>cwd: {cwd}</Text>
      </Box>

      {/* Chat history — memoized so input keystrokes don't re-render
          every message box (v1.2.78 flicker fix). */}
      <ChatHistory messages={messages} agent={agent} chatWidth={chatWidth} />

      {ask && (
        <AskDock
          ask={ask}
          selectedIndex={askActionIndex}
          selectedMulti={askSelectedIndexes}
          customInputMode={askCustomInputMode}
        />
      )}
      {approval && !askPending && (
        <ApprovalDock approval={approval} selectedIndex={approvalActionSafeIndex} actions={approvalActions} />
      )}

      {error && (
        <Box paddingX={1}>
          <Text color="red">⚠ {error}</Text>
        </Box>
      )}

      {/* help overlay */}
      {!palette.open && helpOpen && (
        <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
          <Text>
            <Text bold>快捷键帮助</Text>
            <Text dimColor>  · Esc / ? 关闭</Text>
          </Text>
          <Text dimColor>发送: Enter · 取消生成: Esc · 历史: ↑↓ · 补全: Tab</Text>
          <Text dimColor>面板: Ctrl-P · 退出: Ctrl-C · 多行编辑: /editor</Text>
          <Text dimColor>会话: /new 新会话 · /sessions 最近会话 · /export 导出</Text>
          <Text dimColor>{'特殊输入: !<shell> 运行命令 · @<file> 引用文件'}</Text>
        </Box>
      )}

      {/* Command palette (modal) */}
      {palette.open && (
        <Box flexDirection="column" borderStyle="double" borderColor="magenta" paddingX={1}>
          <Text>
            <Text bold>命令面板</Text>
            <Text dimColor>  · 输入过滤 · ↑↓ 选 · Enter 选中 · Esc 关闭</Text>
          </Text>
          <Text color="cyan">› {palette.query}<Text inverse> </Text></Text>
          {filteredPalette.slice(0, 12).map((c, i) => (
            <Box key={c.id}>
              <Text color={i === palette.index ? 'cyan' : undefined} inverse={i === palette.index}>
                {c.name.padEnd(12)}
              </Text>
              <Text dimColor>  {c.description}</Text>
            </Box>
          ))}
          {filteredPalette.length === 0 && <Text dimColor>(没有匹配的命令)</Text>}
        </Box>
      )}

      {/* @file popup */}
      {!palette.open && filePopupOpen && filteredFiles.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="green" paddingX={1}>
          <Text dimColor>文件引用（{filteredFiles.length} 个匹配；Tab 补全）</Text>
          {filteredFiles.slice(0, 10).map((f, i) => (
            <Text key={f.rel} color={i === popupIndex ? 'green' : undefined} inverse={i === popupIndex}>
              {f.isDir ? '📁 ' : '📄 '}{f.rel}
            </Text>
          ))}
        </Box>
      )}

      {/* slash popup */}
      {!palette.open && slashPopupOpen && filteredSlash.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
          {filteredSlash.map((c, i) => (
            <Box key={c.name}>
              <Text color={i === popupIndex ? 'cyan' : undefined} inverse={i === popupIndex}>
                {c.name.padEnd(10)}
              </Text>
              <Text dimColor>  {c.description}</Text>
            </Box>
          ))}
          <Text dimColor>↑↓ 移动 · Tab 补全 · Enter 选中</Text>
        </Box>
      )}

      {/* /agent argument popup */}
      {!palette.open && agentArgPopupOpen && filteredAgentArgs.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1}>
          <Text dimColor>切换 agent（{filteredAgentArgs.length} 个匹配；Tab 补全 · Enter 选中）</Text>
          {filteredAgentArgs.slice(0, 10).map((a, i) => (
            <Text key={a} color={i === popupIndex ? 'magenta' : undefined} inverse={i === popupIndex}>
              {a}{a === agent ? ' (当前)' : ''}
            </Text>
          ))}
        </Box>
      )}

      {/* Input */}
      <Box borderStyle="single" borderColor={busy ? 'yellow' : 'gray'} paddingX={1} marginTop={(slashPopupOpen || filePopupOpen || agentArgPopupOpen || palette.open || helpOpen) ? 0 : 1}>
        <Text color={busy ? 'yellow' : 'green'}>{busy ? '⠿' : '›'} </Text>
        <TextInput
          value={input}
          onChange={(next) => {
            if (
              next === '?'
              && input.length === 0
              && !busy
              && !palette.open
              && !slashPopupOpen
              && !filePopupOpen
              && !agentArgPopupOpen
            ) {
              setHelpOpen((h) => !h)
              setInput('')
              return
            }
            if (historyCursorRef.current !== -1) {
              historyCursorRef.current = -1
              historyDraftRef.current = ''
            }
            setInput(next)
          }}
          onSubmit={onSubmit}
          placeholder={askPending
            ? (
                askCustomInputMode
                  ? '请输入自定义回复，Enter 提交，Esc 返回选项'
                  : (
                      ask?.selectionMode === 'multi'
                        ? '待决策：↑↓ 选择 · Space 勾选 · Enter 提交'
                        : '待决策：↑↓ 选择 · Enter 确认'
                    )
              )
            : activeApprovalPending
              ? (approval?.prompt.mode === 'auto-allow'
                  ? '默认放行中：Enter 或输入 n 可拒绝'
                  : '审批待处理：用方向键选择，Enter 确认')
              : busy ? '生成中…（Esc 取消）' : '输入消息 · / 命令 · ! shell · @ 文件 · ↑↓ 历史 · ? 帮助 · Ctrl-P 面板'}
          focus={!activeDecisionPending || askCustomInputMode}
        />
      </Box>

      {!activeApprovalPending && approvalStatusLine && <ApprovalStatusBar status={approvalStatusLine} />}

      {/* Bottom status bar */}
      <Box paddingX={1}>
        <Text dimColor>
          <Text>session {shortSessionId(activeSessionId)}</Text>
          <Text>{'  ·  '}</Text>
          <Text>{messages.filter((m) => m.role !== 'system').length} 条消息</Text>
          {currentAgentSession && (
            <Text>{'  ·  '}agent-session {shortSessionId(currentAgentSession)}</Text>
          )}
          {(usage.inTok > 0 || usage.outTok > 0 || usage.costUsd > 0) && (
            <Text>
              {'  ·  '}⇅ {fmtTok(usage.inTok)}/{fmtTok(usage.outTok)} tok
              {usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(4)}` : ''}
            </Text>
          )}
          <Text>{'  ·  '}</Text>
          <Text>/help · ? 帮助 · Ctrl-P 面板 · Ctrl-C 退出</Text>
        </Text>
      </Box>
    </Box>
  )
}
