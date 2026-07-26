// PI agent adapter.
//
// Official CLI surface:
//   pi --mode json -p "<prompt>"
//   pi --mode json -p --session <id> "<prompt>"
//   pi --mode json -p --model <id> "<prompt>"
//   pi --extension <file> ...  (custom tool injection)
//
// PI has no MCP permission hook. For Agim's IM/Web bridge we load a small
// extension that exposes mcp__agim__* tools over approval-bus, and default the
// built-in PI tool surface to read-only. Mutating operations must use Agim's
// approval-gated agim_bash / agim_write / agim_edit extension tools.

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { defaultAgentCwd, resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { crossSpawn } from '../../../utils/cross-platform.js'

const log = rootLogger.child({ component: 'agent.pi' })
const DEFAULT_BIN = 'pi'

export const PI_AGIM_TOOL_NAMES = [
  'web_search',
  'web_fetch',
  'mcp__agim__read_skill',
  'mcp__agim__list_skills',
  'mcp__agim__save_memo',
  'mcp__agim__search_memos',
  'mcp__agim__update_memo',
  'mcp__agim__delete_memo',
  'mcp__agim__request_location_capture',
  'mcp__agim__memory_query',
  'mcp__agim__memory_save',
  'mcp__agim__memory_list',
  'mcp__agim__memory_delete',
  'mcp__agim__create_reminder',
  'mcp__agim__list_reminders',
  'mcp__agim__cancel_reminder',
  'mcp__agim__snooze_reminder',
  'mcp__agim__ask_user',
  'mcp__agim__push_message',
  'mcp__agim__call_agent',
] as const

export const PI_AGIM_MUTATION_TOOL_NAMES = [
  'agim_bash',
  'agim_write',
  'agim_edit',
] as const

const PI_READONLY_BUILTIN_TOOLS = ['read', 'grep', 'find', 'ls'] as const

type PiEvent = {
  type?: string
  id?: string
  message?: {
    role?: string
    usage?: {
      input?: number
      output?: number
      input_tokens?: number
      output_tokens?: number
    }
  }
  assistantMessageEvent?: {
    type?: string
    delta?: string
    content?: string
  }
}

function userHome(): string {
  return process.env.HOME || homedir()
}

function agimExtensionPath(): string {
  const compiled = new URL('./agim-extension.js', import.meta.url).pathname
  if (existsSync(compiled)) return compiled
  return new URL('./agim-extension.ts', import.meta.url).pathname
}

export class PiAdapter extends AgentBase {
  readonly name = 'pi'
  readonly aliases = ['pi-agent']
  readonly kind = 'cli' as const

  private resolvedBin: string | null | undefined = null

  protected get commandName(): string {
    const override = process.env.AGIM_PI_BIN
    if (override) return override
    if (this.resolvedBin !== null) return this.resolvedBin ?? DEFAULT_BIN

    const candidates = [
      join(userHome(), '.local', 'bin', 'pi'),
      '/usr/local/bin/pi',
      '/opt/homebrew/bin/pi',
    ]
    for (const p of candidates) {
      try {
        const s = statSync(p)
        if (s.isFile() && (s.mode & 0o111) !== 0) {
          this.resolvedBin = p
          log.info({ event: 'pi.bin.resolved', path: p }, 'resolved pi outside PATH')
          return p
        }
      } catch { /* not here */ }
    }
    this.resolvedBin = undefined
    return DEFAULT_BIN
  }

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const args = ['--mode', 'json', '--print', '--approve']
    if (opts.agentSessionId) args.push('--session', opts.agentSessionId)
    if (opts.model) args.push('--model', opts.model)

    const tools = [
      ...PI_READONLY_BUILTIN_TOOLS,
      ...PI_AGIM_TOOL_NAMES,
      ...(opts.planMode ? [] : PI_AGIM_MUTATION_TOOL_NAMES),
    ]
    args.push('--tools', tools.join(','))

    args.push(prompt)
    return args
  }

  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    let cwd: string | undefined = resolveAgentCwd(this.name, opts) ?? defaultAgentCwd(this.name)
    if (cwd) {
      try {
        if (!existsSync(cwd)) await mkdir(cwd, { recursive: true })
      } catch (err) {
        log.warn({ event: 'pi.cwd.mkdir_failed', cwd, err: String(err) },
          'falling back to inherited cwd because workspace dir could not be created')
        cwd = undefined
      }
    }

    const args = this.buildArgs(prompt, opts)
    if (cwd) {
      const promptArg = args.pop() as string
      const sessionDir = join(cwd, '.pi-sessions')
      try {
        if (!existsSync(sessionDir)) await mkdir(sessionDir, { recursive: true })
        args.push('--session-dir', sessionDir)
      } catch (err) {
        log.warn({ event: 'pi.session_dir.mkdir_failed', sessionDir, err: String(err) },
          'falling back to PI default session dir')
      }
      args.push(promptArg)
    }

    const sockPath = approvalBus.getSocketPath()
    const { threadId, platform, channelId, userId } = opts
    const runId = randomUUID()
    let registered = false
    if (sockPath && threadId && platform && channelId) {
      approvalBus.registerRun(runId, {
        threadId,
        platform,
        userId: userId ?? '',
        channelId,
        callerAgent: this.name,
        ...(cwd ? { cwd } : {}),
        ...(typeof opts.parentJobId === 'number' ? { parentJobId: opts.parentJobId } : {}),
        ...(typeof opts.callDepth === 'number' ? { callDepth: opts.callDepth } : {}),
        ...(opts.planMode ? { callerPlanMode: true } : {}),
        ...(opts.onToolActivity ? { onToolActivity: opts.onToolActivity } : {}),
      })
      registered = true
      log.info({ event: 'pi.approval.routed', runId, threadId, platform },
        'PI run routed via approval-bus')
    }

    if (sockPath) {
      const promptArg = args.pop() as string
      args.push('--no-extensions', '--extension', agimExtensionPath(), promptArg)
    }

    return {
      args,
      cwd,
      extraEnv: {
        AGIM_RUN_ID: runId,
        ...(sockPath ? { AGIM_APPROVAL_SOCK: sockPath } : {}),
        HOME: userHome(),
      },
      cleanup: async () => {
        if (registered) approvalBus.unregisterRun(runId)
      },
    }
  }

  protected extractText(event: unknown): string {
    const e = event as PiEvent
    if (e.type === 'message_update'
        && e.message?.role === 'assistant'
        && e.assistantMessageEvent?.type === 'text_delta') {
      return e.assistantMessageEvent.delta ?? ''
    }
    // Do not emit message_end content: message_update already streamed the
    // final text, and message_end would duplicate it.
    return ''
  }

  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as PiEvent
    if (e.type === 'session' && !opts.agentSessionId && opts.onAgentSessionId && typeof e.id === 'string' && e.id) {
      try {
        opts.onAgentSessionId(e.id)
        log.info({ event: 'pi.session.captured', id: e.id }, 'captured fresh PI session id')
      } catch (err) {
        log.debug({ event: 'pi.session.callback_failed', err: String(err) })
      }
    }
    if (opts.onUsage && e.type === 'message_end' && e.message?.role === 'assistant' && e.message.usage) {
      const usage = e.message.usage
      const input = usage.input_tokens ?? usage.input ?? 0
      const output = usage.output_tokens ?? usage.output ?? 0
      const delta: { tokensInput?: number; tokensOutput?: number } = {}
      if (input > 0) delta.tokensInput = input
      if (output > 0) delta.tokensOutput = output
      if (delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
        try { opts.onUsage(delta) } catch { /* best-effort */ }
      }
    }
  }

  protected handleError(_code: number, stderr: string, errorMessage: string): string | null {
    const combined = `${stderr} ${errorMessage}`
    if (/No API key found|\/login|API key|provider|authenticate|auth/i.test(combined)) {
      return [
        '🔐 PI 未登录 / 模型凭据缺失。',
        '   在装有 PI 的机器跑：`pi /login`，或设置对应 Provider 的 API Key（例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等）。',
      ].join('\n')
    }
    return null
  }

  protected notAvailableMessage(): string {
    return (
      'PI Agent 未安装。安装：\n' +
      '  npm install -g @earendil-works/pi-coding-agent\n' +
      '装完后跑一次 `pi /login` 或配置 Provider API Key。'
    )
  }

  describe(): string {
    return 'PI CLI · tools: read-only + agim + approval-gated write/exec'
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = crossSpawn(this.commandName, ['--version'], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }
}

export const piAdapter = new PiAdapter()
