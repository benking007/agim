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
import { writeFileSync, mkdtempSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { registry } from '../../core/registry.js'
import { logger as rootLogger } from '../../core/logger.js'
import type { ChatMessage as AgentChatMessage } from '../../core/types.js'
import { Markdown } from './markdown.js'
import { generateSessionId, saveSession, type StoredMessage } from './sessions.js'

const log = rootLogger.child({ component: 'tui' })

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  pending?: boolean
  elapsedMs?: number
  agentName?: string
}

interface SlashCommand {
  name: string
  description: string
  takesArg?: boolean
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/agents',  description: '列出已注册的 agent' },
  { name: '/agent',   description: '切换 agent — 例：/agent codex', takesArg: true },
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
  resumed?: { id: string; agent?: string; messages: ChatMessage[] }
  /** Stable session id — generated upstream and printed on exit so
   *  user can `agim tui --resume <id>` next time. */
  sessionId: string
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
      {messages.map((m, i) => (
        <Box key={i} flexDirection="column" marginBottom={1} width={chatWidth}>
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

export function TuiApp({ initialAgent, resumed, sessionId }: AppProps): JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { setRawMode } = useStdin()

  const [agent, setAgent] = useState<string | undefined>(resumed?.agent ?? initialAgent)
  const [messages, setMessages] = useState<ChatMessage[]>(resumed?.messages ?? [])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [popupIndex, setPopupIndex] = useState(0)
  const [palette, setPalette] = useState<{ open: boolean; query: string; index: number }>({ open: false, query: '', index: 0 })
  const abortRef = useRef<AbortController | null>(null)
  const filesCacheRef = useRef<FileEntry[] | null>(null)

  const cwd = useMemo(() => {
    const home = process.env.HOME
    const c = process.cwd()
    return home && c.startsWith(home) ? '~' + c.slice(home.length) : c
  }, [])

  const cols = stdout?.columns ?? 80
  const chatWidth = Math.min(cols - 4, 120)

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

  useEffect(() => { setPopupIndex(0) }, [filteredSlash.length, filteredFiles.length])

  // ── Command palette (ctrl+p) ──────────────────────────────────────
  const filteredPalette = useMemo(() => {
    if (!palette.open) return [] as SlashCommand[]
    const q = palette.query.toLowerCase().trim()
    if (!q) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter((c) =>
      c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    )
  }, [palette])

  useInput((inputCh, key) => {
    // Ctrl-P opens / closes the command palette regardless of mode.
    if (key.ctrl && inputCh === 'p') {
      setPalette((p) => ({ open: !p.open, query: '', index: 0 }))
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
          setInput(pick.name + (pick.takesArg ? ' ' : ''))
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
  const createdAtRef = useRef<string>(new Date().toISOString())
  const persistSnapshot = useCallback((snap: ChatMessage[], curAgent: string | undefined): void => {
    const stored: StoredMessage[] = snap.map((m) => ({
      role: m.role,
      content: m.content,
      elapsedMs: m.elapsedMs,
      agentName: m.agentName,
    }))
    saveSession({
      id: sessionId,
      agent: curAgent,
      cwd: process.cwd(),
      createdAt: createdAtRef.current,
      updatedAt: new Date().toISOString(),
      messages: stored,
    })
  }, [sessionId])

  // ── helpers ───────────────────────────────────────────────────────

  const pushSystem = useCallback((content: string): void => {
    setMessages((m) => [...m, { role: 'system', content }])
  }, [])

  async function runBash(cmd: string): Promise<void> {
    setMessages((m) => [...m, { role: 'user', content: '!' + cmd }])
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
      for await (const chunk of adapter.sendPrompt(`tui-${process.pid}-compact`, prompt, [], { signal: ac.signal })) {
        summary += chunk
      }
      setMessages([{ role: 'system', content: '【对话已折叠，以下是摘要】\n\n' + summary.trim() }])
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
      { role: 'user', content: text },
      { role: 'assistant', content: '', pending: true, agentName: agent },
    ])

    const ac = new AbortController()
    abortRef.current = ac
    try {
      let chunks = ''
      for await (const chunk of adapter.sendPrompt(`tui-${process.pid}`, text, history, { signal: ac.signal })) {
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
    if (!text || busy) return

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

    setInput('')

    // ── Inline bash ────────────────────────────────────────────────
    if (text.startsWith('!')) {
      const cmd = text.slice(1).trim()
      if (!cmd) { pushSystem('(用法: !<shell 命令>)'); return }
      await runBash(cmd)
      return
    }

    // ── Slash commands ─────────────────────────────────────────────
    if (text === '/exit' || text === '/quit') { exit(); return }
    if (text === '/clear')   { setMessages([]); return }
    if (text === '/redo')    { doRedo(); return }
    if (text === '/undo')    { doUndo(); return }
    if (text === '/editor')  { openEditor(); return }
    if (text === '/compact') { void doCompact(); return }
    if (text === '/export')  { void exportTranscript(); return }
    if (text === '/help') {
      pushSystem(
        SLASH_COMMANDS.map((c) => `${c.name.padEnd(10)} ${c.description}`).join('\n')
        + '\n\n键位：Enter 发送 · Esc 取消 · ↑↓ 选项 · Tab 补全 · Ctrl-P 命令面板 · Ctrl-C 退出'
        + '\n特殊：!<cmd> 行内 bash · @<file> 文件引用',
      )
      return
    }
    if (text === '/agents') {
      const list = registry.listAgents()
      pushSystem(list.length === 0 ? '(没有注册 agent)' : `可用：${list.join(', ')}\n当前：${agent ?? '<none>'}`)
      return
    }
    if (text.startsWith('/agent ')) {
      const next = text.slice('/agent '.length).trim()
      const found = registry.findAgent(next)
      if (!found) { setError(`未找到 agent "${next}"`); return }
      setAgent(found.name)
      pushSystem(`已切换到 agent: ${found.name}`)
      return
    }
    if (text.startsWith('/')) {
      pushSystem(`未知命令: ${text}（输入 /help）`)
      return
    }

    // Regular prompt path — including @file refs left as raw text;
    // the agent receives the literal `@path/to/file` and can choose to
    // read it via its own tools.
    await doSendPrompt(text)
  }

  // ── render ────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box paddingX={1}>
        <Text>
          <Text bold color="cyan">agim TUI</Text>
          <Text dimColor>{'  '}</Text>
          <Text color="green">{agent ?? '<no agent>'}</Text>
        </Text>
      </Box>

      {/* Chat history — memoized so input keystrokes don't re-render
          every message box (v1.2.78 flicker fix). */}
      <ChatHistory messages={messages} agent={agent} chatWidth={chatWidth} />

      {error && (
        <Box paddingX={1}>
          <Text color="red">⚠ {error}</Text>
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
            <Box key={c.name}>
              <Text color={i === palette.index ? 'cyan' : undefined} inverse={i === palette.index}>
                {c.name.padEnd(10)}
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

      {/* Input */}
      <Box borderStyle="single" borderColor={busy ? 'yellow' : 'gray'} paddingX={1} marginTop={(slashPopupOpen || filePopupOpen || palette.open) ? 0 : 1}>
        <Text color={busy ? 'yellow' : 'green'}>{busy ? '⠿' : '›'} </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={busy ? '生成中…（Esc 取消）' : '输入消息 · / 命令 · ! shell · @ 文件 · Ctrl-P 面板'}
        />
      </Box>

      {/* Bottom status bar */}
      <Box paddingX={1}>
        <Text dimColor>
          <Text>{cwd}</Text>
          <Text>{'  ·  '}</Text>
          <Text>{messages.filter((m) => m.role !== 'system').length} 条消息</Text>
          <Text>{'  ·  '}</Text>
          <Text>/help 帮助 · Ctrl-P 面板 · Ctrl-C 退出</Text>
        </Text>
      </Box>
    </Box>
  )
}
