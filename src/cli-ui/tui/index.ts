// agim TUI entry — wired into `agim tui` subcommand.
//
// Modes:
//   * fresh:  agim tui [--agent <name>]
//   * resume: agim tui --resume <session-id>  (auto-picks last if --resume=)
//   * list:   agim tui --list-sessions
//
// Sessions persist to <AGIM_HOME>/tui-sessions/<id>.json after each
// agent turn and on graceful exit. On exit we print the resume hint
// + a trailing newline so the next shell prompt doesn't collide with
// the last rendered frame.

import React from 'react'
import { render } from 'ink'

import { TuiApp, type ChatMessage } from './app.js'
import { registry } from '../../core/registry.js'
import { loadConfig } from '../../core/onboarding.js'
import { logger as rootLogger } from '../../core/logger.js'
import {
  generateSessionId,
  listSessions,
  loadSession,
  type StoredMessage,
} from './sessions.js'

const log = rootLogger.child({ component: 'tui' })

export interface TuiOptions {
  agent?: string
  resume?: string  // session id, or empty string = pick latest
  listSessions?: boolean
}

function formatSessionLine(s: ReturnType<typeof listSessions>[number]): string {
  const ts = s.updatedAt.replace('T', ' ').slice(0, 19)
  const ag = s.agent ? ` · ${s.agent}` : ''
  const msgs = s.messages > 0 ? ` · ${s.messages} 条` : ''
  return `${s.id}  ${ts}${ag}${msgs}`
}

export async function runTui(opts: TuiOptions = {}): Promise<void> {
  // --list-sessions: print and exit (no TTY required for this).
  if (opts.listSessions) {
    const sessions = listSessions(50, true)
    if (sessions.length === 0) {
      console.log('(没有任何已保存的 TUI 会话)')
      return
    }
    console.log(`找到 ${sessions.length} 个 TUI 会话（最新在前）：\n`)
    for (const s of sessions) console.log('  ' + formatSessionLine(s))
    console.log('\n用法：agim tui --resume <id>')
    return
  }

  if (!process.stdout.isTTY) {
    console.error('agim tui: stdout is not a TTY — TUI requires an interactive terminal.')
    process.exit(1)
  }

  // Resolve --resume: empty string / "last" means pick most recent;
  // explicit id means look that one up. Either way, returns null if
  // we couldn't find it and we treat that as a fresh start with a
  // warning.
  let resumed: { id: string; agent?: string; messages: ChatMessage[] } | undefined
  let sessionId: string = generateSessionId()
  let resumeWarning: string | undefined
  if (opts.resume !== undefined) {
    const wantedId = opts.resume.trim()
    if (!wantedId || wantedId === 'last') {
      const sessions = listSessions(1, true)
      if (sessions.length === 0) {
        resumeWarning = '没有可恢复的会话，按新会话启动。'
      } else {
        const s = loadSession(sessions[0].id)
        if (s) {
          resumed = { id: s.id, agent: s.agent, messages: s.messages as ChatMessage[] }
          sessionId = s.id
        } else {
          resumeWarning = `读取最新会话 ${sessions[0].id} 失败，按新会话启动。`
        }
      }
    } else {
      const s = loadSession(wantedId)
      if (s) {
        resumed = { id: s.id, agent: s.agent, messages: s.messages as ChatMessage[] }
        sessionId = s.id
      } else {
        resumeWarning = `没找到会话 "${wantedId}"，按新会话启动。`
      }
    }
  }

  const wantVerbose = process.env.IMHUB_TUI_VERBOSE === '1'
  const savedLevel = rootLogger.level
  if (!wantVerbose) rootLogger.level = 'silent'

  // Clear screen + park cursor at top-left.
  process.stdout.write('\x1b[2J\x1b[H')

  try {
    await registry.loadBuiltInPlugins()
    const cfg = await loadConfig()
    if (cfg.acpAgents && cfg.acpAgents.length > 0) {
      await registry.loadACPAgents(cfg.acpAgents)
    }
  } catch (err) {
    log.warn({ event: 'tui.registry.load_failed', err: err instanceof Error ? err.message : String(err) },
      'registry / config load failed — proceeding best-effort')
  }

  let initialAgent = opts.agent ?? resumed?.agent
  if (initialAgent) {
    const found = registry.findAgent(initialAgent)
    if (!found) {
      const list = registry.listAgents()
      console.error(
        `agim tui: agent "${initialAgent}" not found. Available: ${list.join(', ') || '<none>'}`,
      )
      process.exit(1)
    }
    initialAgent = found.name
  }

  const { waitUntilExit } = render(
    React.createElement(TuiApp, { initialAgent, resumed, sessionId }),
    { patchConsole: true, exitOnCtrlC: true },
  )
  try {
    await waitUntilExit()
  } finally {
    rootLogger.level = savedLevel
    // v1.2.78 — drop a clean newline and print the resume hint AFTER
    // Ink relinquishes the screen. Without these the next shell
    // prompt collides with the last rendered frame, and the user has
    // no way to know they can pick up where they left off.
    process.stdout.write('\n')
    if (resumeWarning) {
      console.warn('⚠ ' + resumeWarning)
    }
    console.log(`会话 ID：${sessionId}`)
    console.log(`恢复命令：agim tui --resume ${sessionId}`)
    console.log(`查看所有会话：agim tui --list-sessions`)
  }
}
