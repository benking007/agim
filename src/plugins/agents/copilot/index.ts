// GitHub Copilot CLI agent adapter.
//
// Official programmatic surface:
//   copilot -p "<prompt>" -s --output-format=text --no-auto-update
//   copilot -p "<prompt>" -s --session-id <uuid> --model <id>
//   copilot --additional-mcp-config @/path/to/mcp.json
//
// We pre-allocate a UUID session id in Agim and pass it to Copilot via
// --session-id. That avoids scraping a tool-specific session id from stdout,
// and gives `/new` a clean reset point just like claude-code.
//
// Tool safety:
// - Programmatic/headless runs need non-interactive permissions or the CLI can
//   stop for prompts nobody can answer from IM/Web.
// - We allow Copilot's tools broadly, then deny native mutation classes and
//   inject Agim MCP tools. Mutating work should go through
//   mcp__agim__agim_bash / agim_write / agim_edit, where Agim renders a
//   user-visible approval card before executing.

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { crossSpawn } from '../../../utils/cross-platform.js'

const log = rootLogger.child({ component: 'agent.copilot' })
const DEFAULT_BIN = 'copilot'

const COPILOT_MUTATION_DENY_PATTERNS = [
  'bash',
  'shell',
  'terminal',
  'exec',
  'run_command',
  'write',
  'write_file',
  'edit',
  'apply_patch',
  'create_file',
  'delete',
  'remove',
  'move',
  'rename',
] as const

function userHome(): string {
  return process.env.HOME || homedir()
}

function sidecarPath(): string {
  return new URL('../claude-code/mcp-approval-server.js', import.meta.url).pathname
}

type CopilotContentItem = {
  type?: string
  text?: string
  content?: string
}

type CopilotUsage = {
  input_tokens?: number
  output_tokens?: number
  inputTokens?: number
  outputTokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type CopilotEvent = {
  type?: string
  role?: string
  error?: string | { message?: string }
  message?: {
    role?: string
    content?: string | CopilotContentItem[]
  }
  content?: string | CopilotContentItem[]
  delta?: string | { text?: string; content?: string }
  text?: string
  result?: string
  usage?: CopilotUsage
}

interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const c = item as CopilotContentItem
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

async function writeMcpConfig(spec: McpServerSpec): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'agim-copilot-mcp-'))
  const path = join(dir, 'mcp.json')
  await writeFile(path, JSON.stringify({ mcpServers: { agim: spec } }, null, 2), { mode: 0o600 })
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export class CopilotAdapter extends AgentBase {
  readonly name = 'copilot'
  readonly aliases = ['co', 'gh-copilot', 'github-copilot']
  readonly kind = 'cli' as const

  private resolvedBin: string | null | undefined = null

  protected get commandName(): string {
    const override = process.env.AGIM_COPILOT_BIN
    if (override) return override
    if (this.resolvedBin !== null) return this.resolvedBin ?? DEFAULT_BIN

    const candidates = [
      join(userHome(), '.local', 'bin', 'copilot'),
      join(userHome(), '.npm-global', 'bin', 'copilot'),
      join(dirname(process.execPath), 'copilot'),
      '/usr/local/bin/copilot',
      '/opt/homebrew/bin/copilot',
    ]
    for (const p of candidates) {
      try {
        const s = statSync(p)
        if (s.isFile() && (s.mode & 0o111) !== 0) {
          this.resolvedBin = p
          log.info({ event: 'copilot.bin.resolved', path: p }, 'resolved copilot outside PATH')
          return p
        }
      } catch { /* not here */ }
    }
    this.resolvedBin = undefined
    return DEFAULT_BIN
  }

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    // Text mode is the most reliable surface for IM/Web delivery. Copilot's
    // JSON mode can exit 0 without emitting an assistant payload in headless
    // service runs, which looks like "no response" to users.
    const args = ['-p', prompt, '-s', '--output-format', 'text', '--no-ask-user', '--no-color', '--no-auto-update']
    if (opts.agentSessionId) args.push('--session-id', opts.agentSessionId)
    if (opts.model) args.push('--model', opts.model)

    if (process.env.AGIM_COPILOT_SAFE_MODE !== '1') {
      args.push('--allow-all-tools', '--allow-all-urls')
      for (const pattern of COPILOT_MUTATION_DENY_PATTERNS) {
        args.push('--deny-tool', pattern)
      }
    }

    return args
  }

  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    let cwd = resolveAgentCwd(this.name, opts)
    if (cwd) {
      try {
        if (!existsSync(cwd)) await mkdir(cwd, { recursive: true })
      } catch (err) {
        log.warn({ event: 'copilot.cwd.mkdir_failed', cwd, err: String(err) },
          'falling back to inherited cwd because workspace dir could not be created')
        cwd = undefined
      }
    }

    let copilotSessionId = opts.agentSessionId
    if (!copilotSessionId) {
      copilotSessionId = randomUUID()
      try {
        opts.onAgentSessionId?.(copilotSessionId)
        log.info({ event: 'copilot.session.preallocated', id: copilotSessionId },
          'preallocated fresh Copilot session id')
      } catch (err) {
        log.debug({ event: 'copilot.session.callback_failed', err: String(err) })
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
      log.info({ event: 'copilot.approval.routed', runId, threadId, platform },
        'Copilot run routed via approval-bus')
    }

    let mcpCleanup: (() => Promise<void>) | undefined
    const args = this.buildArgs(prompt, { ...opts, agentSessionId: copilotSessionId })
    if (cwd) args.push('--add-dir', cwd)
    if (sockPath) {
      try {
        const mcpConfig = await writeMcpConfig({
          command: process.execPath,
          args: [sidecarPath()],
          env: {
            AGIM_APPROVAL_SOCK: sockPath,
            AGIM_RUN_ID: runId,
          },
        })
        args.push('--additional-mcp-config', `@${mcpConfig.path}`, '--allow-tool', 'agim')
        mcpCleanup = mcpConfig.cleanup
      } catch (err) {
        log.warn({ event: 'copilot.mcp.disabled', err: String(err) },
          'agim MCP not wired into Copilot — Agim tools will be invisible this run')
      }
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
        if (mcpCleanup) await mcpCleanup()
      },
    }
  }

  protected extractText(event: unknown): string {
    const e = event as CopilotEvent
    if (typeof e.error === 'string' && e.error) return ''
    if (isRecord(e.error) && typeof e.error.message === 'string' && e.error.message) return ''
    if (e.type === 'assistant' || e.role === 'assistant' || e.message?.role === 'assistant' || e.type === 'message') {
      return contentText(e.message?.content ?? e.content) || e.text || deltaText(e.delta)
    }
    if (e.type === 'delta' || e.type === 'content_block_delta' || e.type === 'assistant_delta') {
      return deltaText(e.delta) || e.text || ''
    }
    // Some programmatic runs only emit a final result event. Use it as a
    // fallback; agents with streamed assistant events do not usually include
    // result text, so this should not double-emit in normal runs.
    if (e.type === 'result' && typeof e.result === 'string') return e.result
    return ''
  }

  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as CopilotEvent
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
    if (/not logged in|login|sign in|authenticate|auth|COPILOT_GITHUB_TOKEN|GITHUB_TOKEN|GH_TOKEN/i.test(combined)) {
      return [
        '🔐 GitHub Copilot CLI 未登录 / 凭据缺失。',
        '   在装有 Copilot CLI 的机器跑：`copilot login`，按提示完成 GitHub 登录。',
        '   或设置 COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN。',
      ].join('\n')
    }
    return null
  }

  protected emptyOutputMessage(stderr: string, errorMessage: string): string | null {
    const combined = `${stderr} ${errorMessage}`
    if (/not logged in|login|sign in|authenticate|auth|COPILOT_GITHUB_TOKEN|GITHUB_TOKEN|GH_TOKEN/i.test(combined)) {
      return this.handleError(0, stderr, errorMessage)
    }
    return [
      '⚠️ GitHub Copilot CLI 没有返回可显示内容。',
      '请在终端运行 `copilot -p "请只回复 OK" -s --output-format text --no-auto-update` 验证登录与网络。',
      '如果终端可正常回复，请重启 Agim 后再试 `/co 你好`。',
    ].join('\n')
  }

  protected notAvailableMessage(): string {
    return (
      'GitHub Copilot CLI 未安装。安装：\n' +
      '  npm install -g @github/copilot\n' +
      '装完后跑一次 `copilot login` 完成登录。'
    )
  }

  describe(): string {
    return 'GitHub Copilot CLI · tools: copilot + agim MCP + approval-gated write/exec'
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = crossSpawn(this.commandName, ['--version'], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }
}

export const copilotAdapter = new CopilotAdapter()
