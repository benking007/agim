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
} from './sessions.js'
import { TuiApprovalBridge } from './approval-bridge.js'
import { approvalBus } from '../../core/approval-bus.js'
import {
  install as installApprovalRouter,
  uninstall as uninstallApprovalRouter,
  bindButtonHandlerForPlatform,
} from '../../core/approval-router.js'

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
  let resumed: { id: string; agent?: string; messages: ChatMessage[]; createdAt?: string; agentSessions?: Record<string, string> } | undefined
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
          resumed = {
            id: s.id,
            agent: s.agent,
            createdAt: s.createdAt,
            agentSessions: s.agentSessions,
            messages: s.messages as ChatMessage[],
          }
          sessionId = s.id
        } else {
          resumeWarning = `读取最新会话 ${sessions[0].id} 失败，按新会话启动。`
        }
      }
    } else {
      const s = loadSession(wantedId)
      if (s) {
        resumed = {
          id: s.id,
          agent: s.agent,
          createdAt: s.createdAt,
          agentSessions: s.agentSessions,
          messages: s.messages as ChatMessage[],
        }
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
    // Mirror the `agim start` boot path so the `native` agent (and any
    // tool wiring that depends on the LLM / MCP registries) actually
    // has a backend at hand. Without this block, `tui` users hitting
    // `native` got "no LLM backend configured for role native-chat
    // or cheap" because both registries were left at their empty
    // module-level singleton state. See cli.ts:96-321 for the same
    // sequence in the daemon path.

    // v1.2.85 parity — load ~/.agim/env so API keys / IMHUB_* tunables
    // edited there reach this process. systemd handles it via the
    // unit's EnvironmentFile=; standalone `agim tui` does not.
    try {
      const { readEnvFile } = await import('../env-file.js')
      const f = readEnvFile()
      for (const [k, v] of Object.entries(f)) {
        if (process.env[k] === undefined) process.env[k] = v
      }
    } catch { /* best-effort */ }

    await registry.loadBuiltInPlugins()
    const cfg = await loadConfig()
    if (cfg.acpAgents && cfg.acpAgents.length > 0) {
      await registry.loadACPAgents(cfg.acpAgents)
    }

    // LLM registry — without this, native agent's pickProvider() returns
    // null and every turn yields the "no LLM backend configured" error.
    try {
      const { loadFromConfig: loadLlmFromConfig } = await import('../../core/llm/registry.js')
      loadLlmFromConfig(cfg)
    } catch (err) {
      log.warn({ event: 'tui.llm_registry.load_failed', err: err instanceof Error ? err.message : String(err) },
        'LLM registry load failed — native agent will be unavailable')
    }

    // MCP registry — best-effort; native uses these for tool calls.
    // Failures here are silent and non-fatal (the daemon path warns,
    // but in TUI we don't want stderr noise spilling into the Ink
    // frame buffer).
    try {
      const { loadFromConfig: loadMcpFromConfig, connectAll } = await import('../../core/llm/mcp-registry.js')
      await loadMcpFromConfig(cfg as { mcpServers?: unknown })
      await connectAll()
    } catch { /* best-effort */ }
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

  let finalSessionId = sessionId
  const approvalBridge = new TuiApprovalBridge(sessionId)
  // Register the in-process TUI messenger so ask_user can resolve
  // platform=tui via message-sink.resolveMessenger().
  registry.registerMessenger(approvalBridge)
  let approvalStarted = false
  if (process.env.IMHUB_APPROVAL_DISABLED !== '1') {
    try {
      const sockPath = approvalBus.getSocketPath() ?? await approvalBus.start()
      process.env.IMHUB_APPROVAL_SOCK = sockPath
      approvalStarted = true
      installApprovalRouter({
        resolveMessenger: (platform: string) => platform === 'tui' ? approvalBridge : undefined,
        buttonCallbackPlatforms: ['tui'],
      })
      bindButtonHandlerForPlatform('tui')
    } catch (err) {
      log.warn({
        event: 'tui.approval.start_failed',
        err: err instanceof Error ? err.message : String(err),
      }, 'TUI approval bridge failed to start')
    }
  }
  const { waitUntilExit } = render(
    React.createElement(TuiApp, {
      initialAgent,
      resumed,
      sessionId,
      onSessionIdChange: (id: string) => { finalSessionId = id },
      approvalBridge,
    }),
    { patchConsole: true, exitOnCtrlC: true },
  )
  try {
    await waitUntilExit()
  } finally {
    if (approvalStarted) {
      uninstallApprovalRouter()
      await approvalBus.stop().catch(() => {})
    }
    rootLogger.level = savedLevel
    // v1.2.78 — drop a clean newline and print the resume hint AFTER
    // Ink relinquishes the screen. Without these the next shell
    // prompt collides with the last rendered frame, and the user has
    // no way to know they can pick up where they left off.
    process.stdout.write('\n')
    if (resumeWarning) {
      console.warn('⚠ ' + resumeWarning)
    }
    console.log(`会话 ID：${finalSessionId}`)
    console.log(`恢复命令：agim tui --resume ${finalSessionId}`)
    console.log(`查看所有会话：agim tui --list-sessions`)
  }
}
