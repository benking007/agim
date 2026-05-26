// agim TUI (v1.2.76 + opencode-inspired pass) — Ink chat UI.
//
// Iteration 2 changes (per user feedback after seeing opencode's TUI):
//   * Slash-command popup with arrow-key navigation + descriptions
//   * Bottom status bar (agent / cwd / hint)
//   * Per-message "agent · elapsed" footer on assistant replies
//   * Tightened header (drops the hint row — now lives in the status bar)
//
// Still deferred:
//   * Multi-session list (left sidebar)
//   * Right context panel (token/cost — needs adapter hooks)
//   * Multi-line input (Shift+Enter newline) — ink-text-input still
//     single-line; will switch to a custom buffer later
//   * Markdown rendering (kept plain to avoid CJK width issues)
//   * Approval-card integration (no approval-bus in TUI yet)

import React, { useEffect, useState, useRef, useMemo } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'

import { registry } from '../../core/registry.js'
import { logger as rootLogger } from '../../core/logger.js'

const log = rootLogger.child({ component: 'tui' })

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  pending?: boolean
  /** ms elapsed from prompt to last chunk — assistant-only */
  elapsedMs?: number
  /** agent name at the time of this turn — assistant-only */
  agentName?: string
}

interface SlashCommand {
  name: string             // e.g. '/agents'
  description: string
  takesArg?: boolean       // if true, popup leaves a space after insertion
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/agents', description: '列出已注册的所有 agent' },
  { name: '/agent',  description: '切换 agent — 例：/agent codex', takesArg: true },
  { name: '/clear',  description: '清空当前对话历史' },
  { name: '/help',   description: '显示帮助信息' },
  { name: '/exit',   description: '退出 TUI' },
  { name: '/quit',   description: '退出 TUI（同 /exit）' },
]

interface AppProps {
  initialAgent?: string
}

export function TuiApp({ initialAgent }: AppProps): JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [agent, setAgent] = useState<string | undefined>(initialAgent)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [popupIndex, setPopupIndex] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const cwd = useMemo(() => {
    const home = process.env.HOME
    const c = process.cwd()
    return home && c.startsWith(home) ? '~' + c.slice(home.length) : c
  }, [])

  const cols = stdout?.columns ?? 80
  const chatWidth = Math.min(cols - 4, 120)

  // Filter slash commands by current input. Popup is open while input
  // starts with '/' and contains no space (= still typing the verb).
  const popupOpen = input.startsWith('/') && !input.includes(' ')
  const filteredCommands = useMemo(() => {
    if (!popupOpen) return [] as SlashCommand[]
    const q = input.toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
  }, [input, popupOpen])

  // Reset popup selection when filter changes; clamp into range.
  useEffect(() => {
    if (popupIndex >= filteredCommands.length) setPopupIndex(0)
  }, [filteredCommands, popupIndex])

  useInput((_inputCh, key) => {
    if (popupOpen && filteredCommands.length > 0) {
      if (key.upArrow) {
        setPopupIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (key.downArrow) {
        setPopupIndex((i) => (i + 1) % filteredCommands.length)
        return
      }
      if (key.tab) {
        // Tab: accept the highlighted suggestion into the input, but
        // don't submit. Lets user keep typing args.
        const pick = filteredCommands[popupIndex]
        if (pick) setInput(pick.name + (pick.takesArg ? ' ' : ''))
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

  async function onSubmit(line: string): Promise<void> {
    const text = line.trim()
    if (!text || busy) return

    // Popup case: if input is a bare slash prefix (no space, no full
    // word that matches a real command), submitting Enter should pick
    // the highlighted suggestion instead of running it raw.
    if (popupOpen && filteredCommands.length > 0) {
      const exact = filteredCommands.find((c) => c.name === text)
      if (!exact) {
        const pick = filteredCommands[popupIndex]
        if (pick) {
          setInput(pick.name + (pick.takesArg ? ' ' : ''))
          return
        }
      }
    }

    setInput('')

    if (text === '/exit' || text === '/quit') {
      exit()
      return
    }
    if (text === '/clear') {
      setMessages([])
      return
    }
    if (text === '/help') {
      setMessages((m) => [...m, {
        role: 'system',
        content: SLASH_COMMANDS.map((c) => `${c.name.padEnd(10)} ${c.description}`).join('\n')
          + '\n\n键位：Enter 发送 · Esc 取消生成 · ↑↓ 选 slash · Tab 补全 · Ctrl-C 退出',
      }])
      return
    }
    if (text === '/agents') {
      const list = registry.listAgents()
      setMessages((m) => [...m, {
        role: 'system',
        content: list.length === 0
          ? '(没有注册任何 agent — 检查 registry 是否加载)'
          : `可用 agents: ${list.join(', ')}\n当前：${agent ?? '<none>'}`,
      }])
      return
    }
    if (text.startsWith('/agent ')) {
      const next = text.slice('/agent '.length).trim()
      const found = registry.findAgent(next)
      if (!found) {
        setError(`未找到 agent "${next}"。可用：${registry.listAgents().join(', ') || '<empty>'}`)
        return
      }
      setAgent(found.name)
      setError(null)
      setMessages((m) => [...m, { role: 'system', content: `已切换到 agent: ${found.name}` }])
      return
    }
    if (text.startsWith('/')) {
      setMessages((m) => [...m, { role: 'system', content: `未知命令: ${text}（输入 /help 查看可用命令）` }])
      return
    }

    if (!agent) {
      setError('未选择 agent — 用 /agent <name> 指定，或退出后 agim tui --agent <name>')
      return
    }
    const adapter = registry.findAgent(agent)
    if (!adapter) {
      setError(`agent "${agent}" 不在 registry 里`)
      return
    }

    setError(null)
    setBusy(true)
    const startMs = Date.now()
    setMessages((m) => [
      ...m,
      { role: 'user', content: text },
      { role: 'assistant', content: '', pending: true, agentName: agent },
    ])

    const ac = new AbortController()
    abortRef.current = ac
    const sessionId = `tui-${process.pid}`
    try {
      let chunks = ''
      for await (const chunk of adapter.sendPrompt(sessionId, text, [], { signal: ac.signal })) {
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

  return (
    <Box flexDirection="column" width="100%">
      {/* Header — compact, single row */}
      <Box paddingX={1}>
        <Text>
          <Text bold color="cyan">agim TUI</Text>
          <Text dimColor>{'  '}</Text>
          <Text color="green">{agent ?? '<no agent>'}</Text>
        </Text>
      </Box>

      {/* Chat history */}
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {messages.length === 0 && (
          <Text dimColor>(空) 输入消息开始对话。按 / 唤出 slash 命令面板。</Text>
        )}
        {messages.map((m, i) => (
          <Box key={i} flexDirection="column" marginBottom={1} width={chatWidth}>
            <Text>
              {m.role === 'user' && <Text color="cyan" bold>你 </Text>}
              {m.role === 'assistant' && <Text color="magenta" bold>{m.agentName || agent || 'agent'} </Text>}
              {m.role === 'system' && <Text color="yellow" bold>系统 </Text>}
              {m.pending && <Text dimColor>· 正在生成…（Esc 取消）</Text>}
            </Text>
            <Text>{m.content || (m.pending ? '…' : '')}</Text>
            {m.role === 'assistant' && !m.pending && m.elapsedMs !== undefined && (
              <Text dimColor>■ {m.agentName || agent} · {(m.elapsedMs / 1000).toFixed(1)}s</Text>
            )}
          </Box>
        ))}
      </Box>

      {error && (
        <Box paddingX={1}>
          <Text color="red">⚠ {error}</Text>
        </Box>
      )}

      {/* Slash-command popup — sits ABOVE the input box, visible only
          when the user is typing a slash command prefix. */}
      {popupOpen && filteredCommands.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" marginTop={0} paddingX={1}>
          {filteredCommands.map((c, i) => (
            <Box key={c.name}>
              <Text
                color={i === popupIndex ? 'cyan' : undefined}
                inverse={i === popupIndex}
              >
                {c.name.padEnd(10)}
              </Text>
              <Text dimColor>  {c.description}</Text>
            </Box>
          ))}
          <Text dimColor>↑↓ 移动 · Tab 补全 · Enter 选中</Text>
        </Box>
      )}

      {/* Input row */}
      <Box borderStyle="single" borderColor={busy ? 'yellow' : 'gray'} paddingX={1} marginTop={popupOpen ? 0 : 1}>
        <Text color={busy ? 'yellow' : 'green'}>{busy ? '⠿' : '›'} </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={busy ? '生成中…（Esc 取消）' : '输入消息 · / 唤出命令'}
        />
      </Box>

      {/* Bottom status bar — orientation for first-time users */}
      <Box paddingX={1}>
        <Text dimColor>
          <Text>{cwd}</Text>
          <Text>{'  ·  '}</Text>
          <Text>{messages.filter((m) => m.role !== 'system').length} 条消息</Text>
          <Text>{'  ·  '}</Text>
          <Text>Enter 发送 · Esc 取消 · / 命令 · Ctrl-C 退出</Text>
        </Text>
      </Box>
    </Box>
  )
}
