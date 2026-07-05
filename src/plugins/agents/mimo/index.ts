// MiMo Code agent adapter.
//
// Official CLI surface:
//   mimo run --format json "<prompt>"
//   mimo run --format json --session <id> "<prompt>"
//   mimo run --format json --model <provider/model> "<prompt>"
//   mimo models
//
// MiMo's default permission model is permissive for many tools. For Agim's
// IM/Web bridge we keep the native MiMo mutation tools closed via
// MIMOCODE_PERMISSION and expose Agim-owned MCP tools instead. Mutating calls
// should go through mcp__agim__agim_bash / agim_write / agim_edit, where Agim
// can render a human approval card before executing.

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

const log = rootLogger.child({ component: 'agent.mimo' })
const DEFAULT_BIN = 'mimo'

function userHome(): string {
  return process.env.HOME || homedir()
}

function sidecarPath(): string {
  return new URL('../claude-code/mcp-approval-server.js', import.meta.url).pathname
}

type JsonRecord = Record<string, unknown>

interface MimoMcpServerSpec {
  type: 'local'
  command: string[]
  enabled: boolean
  environment: Record<string, string>
}

type MimoContentItem = {
  type?: string
  text?: string
  content?: string
}

type MimoUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  inputTokens?: number
  outputTokens?: number
  input?: number
  output?: number
  cache?: {
    write?: number
    read?: number
  }
}

type MimoPart = {
  type?: string
  text?: string
  sessionID?: string
  tokens?: MimoUsage
}

type MimoEvent = {
  type?: string
  subtype?: string
  role?: string
  id?: string
  session_id?: string
  sessionId?: string
  sessionID?: string
  session?: {
    id?: string
  }
  part?: MimoPart
  error?: string | { message?: string }
  is_error?: boolean
  result?: string
  text?: string
  message?: {
    role?: string
    content?: string | MimoContentItem[]
  }
  content?: string | MimoContentItem[]
  delta?: string | { text?: string; content?: string }
  usage?: MimoUsage
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonRecord(raw: string | undefined): JsonRecord {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const c = item as MimoContentItem
    if ((c.type === undefined || c.type === 'text') && typeof c.text === 'string') {
      parts.push(c.text)
    } else if (typeof c.content === 'string') {
      parts.push(c.content)
    }
  }
  return parts.join('')
}

function deltaText(delta: unknown): string {
  if (typeof delta === 'string') return delta
  if (!isRecord(delta)) return ''
  const text = delta.text
  if (typeof text === 'string') return text
  const content = delta.content
  return typeof content === 'string' ? content : ''
}

function buildMimoConfig(spec?: MimoMcpServerSpec): string {
  const base = parseJsonRecord(process.env.MIMOCODE_CONFIG_CONTENT)
  if (typeof base.$schema !== 'string') {
    base.$schema = 'https://mimo.xiaomi.com/mimocode/config.json'
  }
  if (spec) {
    const mcp = isRecord(base.mcp) ? { ...base.mcp } : {}
    mcp.agim = spec
    base.mcp = mcp
  }
  return JSON.stringify(base)
}

function buildMimoPermission(): string {
  const permission = parseJsonRecord(process.env.MIMOCODE_PERMISSION)
  // Keep network/search readable in headless IM runs. The Agim MCP server
  // still provides user-scoped memory/skill tools; MiMo's own web tools are
  // useful fallback for current public information.
  permission.webfetch = 'allow'
  permission.websearch = 'allow'
  // MiMo's native mutation tools have their own prompts, which are not
  // visible to Agim's IM approval cards. Deny them and route mutation via
  // mcp__agim__agim_bash / agim_write / agim_edit instead.
  permission.bash = 'deny'
  permission.edit = 'deny'
  permission.external_directory = 'deny'
  permission.task = 'deny'
  return JSON.stringify(permission)
}

export class MimoAdapter extends AgentBase {
  readonly name = 'mimo'
  readonly aliases = ['mo', 'mimo-code']
  readonly kind = 'cli' as const

  private resolvedBin: string | null | undefined = null

  protected get commandName(): string {
    const override = process.env.AGIM_MIMO_BIN
    if (override) return override
    if (this.resolvedBin !== null) return this.resolvedBin ?? DEFAULT_BIN

    const candidates = [
      join(userHome(), '.mimocode', 'bin', 'mimo'),
      join(userHome(), '.local', 'bin', 'mimo'),
      join(userHome(), '.mimo', 'bin', 'mimo'),
      '/usr/local/bin/mimo',
      '/opt/homebrew/bin/mimo',
      '/opt/mimo/bin/mimo',
    ]
    for (const p of candidates) {
      try {
        const s = statSync(p)
        if (s.isFile() && (s.mode & 0o111) !== 0) {
          this.resolvedBin = p
          log.info({ event: 'mimo.bin.resolved', path: p }, 'resolved mimo outside PATH')
          return p
        }
      } catch { /* not here */ }
    }
    this.resolvedBin = undefined
    return DEFAULT_BIN
  }

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const args = ['run', '--format', 'json']
    if (opts.agentSessionId) args.push('--session', opts.agentSessionId)
    if (opts.model) args.push('--model', opts.model)
    args.push(prompt)
    return args
  }

  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    let cwd = resolveAgentCwd(this.name, opts)
    if (cwd) {
      try {
        if (!existsSync(cwd)) await mkdir(cwd, { recursive: true })
      } catch (err) {
        log.warn({ event: 'mimo.cwd.mkdir_failed', cwd, err: String(err) },
          'falling back to inherited cwd because workspace dir could not be created')
        cwd = undefined
      }
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
      })
      registered = true
      log.info({ event: 'mimo.approval.routed', runId, threadId, platform },
        'MiMo run routed via approval-bus')
    }

    const configContent = buildMimoConfig(sockPath ? {
      type: 'local',
      command: [process.execPath, sidecarPath()],
      enabled: true,
      environment: {
        AGIM_APPROVAL_SOCK: sockPath,
        AGIM_RUN_ID: runId,
      },
    } : undefined)

    return {
      args: this.buildArgs(prompt, opts),
      cwd,
      extraEnv: {
        AGIM_RUN_ID: runId,
        ...(sockPath ? { AGIM_APPROVAL_SOCK: sockPath } : {}),
        HOME: userHome(),
        MIMOCODE_CONFIG_CONTENT: configContent,
        MIMOCODE_PERMISSION: buildMimoPermission(),
      },
      cleanup: async () => {
        if (registered) approvalBus.unregisterRun(runId)
      },
    }
  }

  protected extractText(event: unknown): string {
    const e = event as MimoEvent
    if (typeof e.error === 'string' && e.error) return ''
    if (isRecord(e.error) && typeof e.error.message === 'string' && e.error.message) return ''
    if (e.type === 'assistant'
        || e.role === 'assistant'
        || e.message?.role === 'assistant'
        || e.type === 'message') {
      return contentText(e.message?.content ?? e.content) || e.text || deltaText(e.delta)
    }
    if (e.type === 'text' || e.part?.type === 'text') {
      return e.part?.text || e.text || contentText(e.content)
    }
    if (e.type === 'delta' || e.type === 'content_block_delta' || e.type === 'assistant_delta') {
      return deltaText(e.delta) || e.text || ''
    }
    // Avoid double-emitting terminal result events when streamed assistant
    // events already carried the same content.
    return ''
  }

  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as MimoEvent
    const sessionId = e.session_id || e.sessionId || e.sessionID || e.session?.id || e.part?.sessionID
    if (!opts.agentSessionId && opts.onAgentSessionId && typeof sessionId === 'string' && sessionId) {
      try {
        opts.onAgentSessionId(sessionId)
        log.info({ event: 'mimo.session.captured', id: sessionId }, 'captured fresh MiMo session id')
      } catch (err) {
        log.debug({ event: 'mimo.session.callback_failed', err: String(err) })
      }
    }
    const usage = e.usage ?? e.part?.tokens
    if (opts.onUsage && usage) {
      const u = usage
      const input = (u.input_tokens ?? u.inputTokens ?? 0)
        + (u.cache_creation_input_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0)
        + (u.input ?? 0)
        + (u.cache?.write ?? 0)
        + (u.cache?.read ?? 0)
      const output = u.output_tokens ?? u.outputTokens ?? u.output ?? 0
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
    if (/not logged in|token plan|api key|login|log in|authenticate|auth/i.test(combined)) {
      return [
        '🔐 MiMo Code 未登录 / Token Plan 凭据缺失。',
        '   在装有 MiMo Code 的机器跑：`mimo auth login`，按提示绑定 Token Plan。',
      ].join('\n')
    }
    return null
  }

  protected notAvailableMessage(): string {
    return (
      'MiMo Code CLI 未安装。安装：\n' +
      '  npm install -g @mimo-ai/cli\n' +
      '或运行官方安装脚本；装完后跑一次 `mimo auth login` 完成登录。'
    )
  }

  describe(): string {
    return 'MiMo Code CLI · tools: web + agim + approval-gated write/exec'
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = crossSpawn(this.commandName, ['--version'], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }
}

export const mimoAdapter = new MimoAdapter()
