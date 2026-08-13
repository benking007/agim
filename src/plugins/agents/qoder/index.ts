// Qoder CLI agent adapter.
//
// Observed on qodercli 1.0.37:
//   qodercli --print --output-format stream-json "<prompt>"
//     ↓
//     newline-delimited events: system/init, assistant, result. Events carry
//     session_id; the result event carries usage and is_error.
//   qodercli --print --output-format stream-json --resume <id> "<prompt>"
//   qodercli --print --output-format stream-json --model <id> "<prompt>"
//   qodercli --mcp-config <inline-json> --allowed-mcp-server-names agim ...
//
// We intentionally inject Agim MCP via a per-run inline --mcp-config instead
// of mutating ~/.qoder settings. That keeps AGIM_RUN_ID unique for the IM
// thread that launched this specific turn, so memory / skills / ask_user /
// call_agent route back to the right approvalBus context.

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { crossSpawn } from '../../../utils/cross-platform.js'
import { pushPromptArg, takeTrailingPrompt } from '../cli-prompt-arg.js'

const log = rootLogger.child({ component: 'agent.qoder' })
const DEFAULT_BIN = 'qodercli'
const QODER_PERMISSION_MODES = ['default', 'accept_edits', 'bypass_permissions', 'dont_ask', 'auto'] as const
const QODER_HEADLESS_ALLOWED_TOOLS = [
  'WebSearch',
  'WebFetch',
  'mcp__agim__*',
] as const
const QODER_MUTATION_DENYLIST = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'CronCreate',
  'CronDelete',
] as const

function userHome(): string {
  return process.env.HOME || homedir()
}

function sidecarPath(): string {
  return new URL('../claude-code/mcp-approval-server.js', import.meta.url).pathname
}

type QoderContentItem = {
  type?: string
  text?: string
  content?: string
}

type QoderUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  inputTokens?: number
  outputTokens?: number
}

type QoderEvent = {
  type?: string
  subtype?: string
  session_id?: string
  sessionId?: string
  error?: string
  is_error?: boolean
  result?: string
  message?: {
    role?: string
    content?: string | QoderContentItem[]
  }
  content?: string | QoderContentItem[]
  delta?: { text?: string; content?: string }
  usage?: QoderUsage
}

interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const c = item as QoderContentItem
    if ((c.type === undefined || c.type === 'text') && typeof c.text === 'string') {
      parts.push(c.text)
    } else if (typeof c.content === 'string') {
      parts.push(c.content)
    }
  }
  return parts.join('')
}

function buildMcpConfig(spec: McpServerSpec): string {
  return JSON.stringify({ mcpServers: { agim: spec } })
}

function qoderPermissionMode(planMode: boolean | undefined): string {
  const mode = process.env.AGIM_QODER_PERMISSION_MODE?.trim()
  if (mode && (QODER_PERMISSION_MODES as readonly string[]).includes(mode)) {
    return mode
  }
  if (mode) {
    log.warn({ event: 'qoder.permission_mode.invalid', mode }, 'ignoring invalid AGIM_QODER_PERMISSION_MODE')
  }
  return planMode ? 'default' : 'bypass_permissions'
}

export class QoderAdapter extends AgentBase {
  readonly name = 'qoder'
  readonly aliases = ['qd', 'qodercli']
  readonly kind = 'cli' as const

  private resolvedBin: string | null | undefined = null

  protected get commandName(): string {
    const override = process.env.AGIM_QODER_BIN
    if (override) return override
    if (this.resolvedBin !== null) return this.resolvedBin ?? DEFAULT_BIN

    const candidates = [
      join(userHome(), '.local', 'bin', 'qodercli'),
      join(userHome(), '.qoder', 'bin', 'qodercli', 'qodercli'),
      '/usr/local/bin/qodercli',
      '/opt/homebrew/bin/qodercli',
      '/opt/qoder/bin/qodercli',
    ]
    for (const p of candidates) {
      try {
        const s = statSync(p)
        if (s.isFile() && (s.mode & 0o111) !== 0) {
          this.resolvedBin = p
          log.info({ event: 'qoder.bin.resolved', path: p }, 'resolved qodercli outside PATH')
          return p
        }
      } catch { /* not here */ }
    }
    this.resolvedBin = undefined
    return DEFAULT_BIN
  }

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const args = ['--print', '--output-format', 'stream-json']
    if (opts.agentSessionId) args.push('--resume', opts.agentSessionId)
    if (opts.model) args.push('--model', opts.model)

    args.push('--permission-mode', qoderPermissionMode(opts.planMode))
    args.push('--allowed-tools', QODER_HEADLESS_ALLOWED_TOOLS.join(','))

    args.push('--disallowed-tools', QODER_MUTATION_DENYLIST.join(','))

    pushPromptArg(args, prompt)
    return args
  }

  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    let cwd = resolveAgentCwd(this.name, opts)
    if (cwd) {
      try {
        if (!existsSync(cwd)) await mkdir(cwd, { recursive: true })
      } catch (err) {
        log.warn({ event: 'qoder.cwd.mkdir_failed', cwd, err: String(err) },
          'falling back to inherited cwd because workspace dir could not be created')
        cwd = undefined
      }
    }

    const baseArgs = this.buildArgs(prompt, opts)
    if (cwd) {
      const promptArg = takeTrailingPrompt(baseArgs)
      baseArgs.push('--cwd', cwd)
      pushPromptArg(baseArgs, promptArg)
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
      log.info({ event: 'qoder.approval.routed', runId, threadId, platform },
        'Qoder run routed via approval-bus')
    }

    const args = [...baseArgs]
    if (sockPath) {
      const mcpConfig = buildMcpConfig({
        command: process.execPath,
        args: [sidecarPath()],
        env: {
          AGIM_APPROVAL_SOCK: sockPath,
          AGIM_RUN_ID: runId,
        },
      })
      const promptArg = takeTrailingPrompt(args)
      args.push(
        '--mcp-config',
        mcpConfig,
        '--allowed-mcp-server-names',
        'agim',
      )
      pushPromptArg(args, promptArg)
    }

    return {
      args,
      cwd,
      extraEnv: {
        AGIM_RUN_ID: runId,
        HOME: userHome(),
      },
      cleanup: async () => {
        if (registered) approvalBus.unregisterRun(runId)
      },
    }
  }

  protected extractText(event: unknown): string {
    const e = event as QoderEvent
    if (typeof e.error === 'string' && e.error) return ''
    if (e.type === 'assistant' || e.message?.role === 'assistant') {
      return contentText(e.message?.content ?? e.content) || e.delta?.text || e.delta?.content || ''
    }
    if (e.type === 'delta' || e.type === 'content_block_delta') {
      return e.delta?.text || e.delta?.content || ''
    }
    return ''
  }

  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as QoderEvent
    const sessionId = e.session_id || e.sessionId
    if (!opts.agentSessionId && opts.onAgentSessionId && typeof sessionId === 'string' && sessionId) {
      try {
        opts.onAgentSessionId(sessionId)
        log.info({ event: 'qoder.session.captured', id: sessionId }, 'captured fresh Qoder session id')
      } catch (err) {
        log.debug({ event: 'qoder.session.callback_failed', err: String(err) })
      }
    }
    if (opts.onUsage && e.usage) {
      const u = e.usage
      const input = (u.input_tokens ?? u.inputTokens ?? 0)
        + (u.cache_creation_input_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0)
      const output = u.output_tokens ?? u.outputTokens ?? 0
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
    if (/not logged in|please run \/login|login|authenticate|auth/i.test(combined)) {
      return [
        '🔐 Qoder 未登录 / 凭据缺失。',
        '   在装有 Qoder CLI 的机器跑：`qodercli login`，按提示完成登录。',
      ].join('\n')
    }
    return null
  }

  protected notAvailableMessage(): string {
    return (
      'Qoder CLI 未安装。安装：\n' +
      '  curl -fsSL https://qoder.com/install | sh\n' +
      '装完后跑一次 `qodercli login` 完成首次登录。'
    )
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = crossSpawn(this.commandName, ['--version'], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }
}

export const qoderAdapter = new QoderAdapter()
