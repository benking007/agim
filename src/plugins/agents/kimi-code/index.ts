// Kimi Code agent adapter.
//
// CLI surface documented by Moonshot:
//   kimi -p "<prompt>" --output-format stream-json
//   kimi -p "<prompt>" --session <session-id>
//   kimi -p "<prompt>" --model <model-id>
//
// Notes:
// - Kimi's --prompt / -p mode conflicts with --plan / --auto / --yolo in the
//   current CLI docs. We therefore do not pretend that Agim plan mode maps to
//   a native Kimi read-only permission gate. Workspace isolation and Kimi's
//   own static permission rules remain the safety floor for built-in tools.
// - Agim MCP tools are still wired through ~/.kimi-code/mcp.json. Because
//   Kimi reads MCP config from a user-level file, Agim rewrites the agim MCP
//   entry per run with the current AGIM_RUN_ID so memo / memory / ask_user /
//   call_agent / approved native tools route back to the originating IM thread.

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { crossSpawn } from '../../../utils/cross-platform.js'
import { ensureAgimMcp, kimiCodeHome } from './ensure-mcp-config.js'

const log = rootLogger.child({ component: 'agent.kimi-code' })
const DEFAULT_BIN = 'kimi'

function sidecarPath(): string {
  return new URL('../claude-code/mcp-approval-server.js', import.meta.url).pathname
}

export function sessionIndexPath(): string {
  return join(kimiCodeHome(), 'session_index.jsonl')
}

interface KimiSessionIndexRow {
  sessionId?: string
  session_id?: string
  id?: string
  sessionDir?: string
  workDir?: string
  updatedAt?: string
  createdAt?: string
}

function readSessionIdsFromIndex(raw: string): string[] {
  const ids: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row = JSON.parse(trimmed) as KimiSessionIndexRow
      const id = row.sessionId || row.session_id || row.id
      if (typeof id === 'string' && id.trim()) ids.push(id.trim())
    } catch {
      // Ignore corrupt rows; Kimi owns this file and may append partial lines.
    }
  }
  return ids
}

export async function snapshotKimiSessionIds(path = sessionIndexPath()): Promise<Set<string>> {
  try {
    return new Set(readSessionIdsFromIndex(await readFile(path, 'utf8')))
  } catch {
    return new Set()
  }
}

export async function detectNewKimiSessionId(before: Set<string>, path = sessionIndexPath()): Promise<string | null> {
  let ids: string[]
  try {
    ids = readSessionIdsFromIndex(await readFile(path, 'utf8'))
  } catch {
    return null
  }
  // The index is append-oriented. Pick the freshest id that was not present
  // before launch, scanning backward so resumed / rewritten rows prefer last.
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const id = ids[i]
    if (!before.has(id)) return id
  }
  return null
}

type KimiContentItem = {
  type?: string
  text?: string
  content?: string
}

type KimiEvent = {
  type?: string
  role?: string
  text?: string
  content?: string | KimiContentItem[]
  delta?: { text?: string; content?: string }
  message?: {
    role?: string
    content?: string | KimiContentItem[]
  }
  session_id?: string
  sessionId?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    inputTokens?: number
    outputTokens?: number
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const c = item as KimiContentItem
    if ((c.type === undefined || c.type === 'text') && typeof c.text === 'string') {
      parts.push(c.text)
    } else if (typeof c.content === 'string') {
      parts.push(c.content)
    }
  }
  return parts.join('')
}

export class KimiCodeAdapter extends AgentBase {
  readonly name = 'kimi-code'
  readonly aliases = ['kimi', 'km']
  readonly kind = 'cli' as const

  private resolvedBin: string | null | undefined = null

  protected get commandName(): string {
    const override = process.env.AGIM_KIMI_CODE_BIN
    if (override) return override
    if (this.resolvedBin !== null) return this.resolvedBin ?? DEFAULT_BIN

    const candidates = [
      join(kimiCodeHome(), 'bin', 'kimi'),
      join(homedir(), '.local', 'bin', 'kimi'),
      '/usr/local/bin/kimi',
      '/opt/homebrew/bin/kimi',
      '/opt/kimi/bin/kimi',
    ]
    for (const p of candidates) {
      try {
        const s = statSync(p)
        if (s.isFile() && (s.mode & 0o111) !== 0) {
          this.resolvedBin = p
          log.info({ event: 'kimi.bin.resolved', path: p }, 'resolved kimi outside PATH')
          return p
        }
      } catch { /* not here */ }
    }
    this.resolvedBin = undefined
    return DEFAULT_BIN
  }

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const args = ['-p', prompt, '--output-format', 'stream-json']
    if (opts.agentSessionId) args.push('--session', opts.agentSessionId)
    if (opts.model) args.push('--model', opts.model)
    return args
  }

  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    let cwd = resolveAgentCwd(this.name, opts)
    if (cwd) {
      try {
        if (!existsSync(cwd)) await mkdir(cwd, { recursive: true })
      } catch (err) {
        log.warn({ event: 'kimi.cwd.mkdir_failed', cwd, err: String(err) },
          'falling back to inherited cwd because workspace dir could not be created')
        cwd = undefined
      }
    }

    const sockPath = approvalBus.getSocketPath()
    const { threadId, platform, channelId, userId } = opts
    const runId = randomUUID()

    if (sockPath) {
      try {
        await ensureAgimMcp({
          command: process.execPath,
          args: [sidecarPath()],
          env: {
            AGIM_APPROVAL_SOCK: sockPath,
            AGIM_RUN_ID: runId,
          },
        })
      } catch (err) {
        log.warn({ event: 'kimi.mcp.disabled', err: String(err) },
          'agim MCP not wired into Kimi Code — Agim tools will be invisible this run')
      }
    }

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
      log.info({ event: 'kimi.approval.routed', runId, threadId, platform },
        'Kimi Code run routed via approval-bus')
    }

    const beforeSnapshot = opts.agentSessionId ? null : await snapshotKimiSessionIds()

    return {
      args: this.buildArgs(prompt, opts),
      cwd,
      extraEnv: {
        AGIM_RUN_ID: runId,
        HOME: process.env.HOME || homedir(),
      },
      cleanup: async () => {
        if (registered) approvalBus.unregisterRun(runId)
        if (!opts.agentSessionId && opts.onAgentSessionId && beforeSnapshot) {
          const id = await detectNewKimiSessionId(beforeSnapshot)
          if (id) {
            try {
              opts.onAgentSessionId(id)
              log.info({ event: 'kimi.session.captured', id }, 'captured fresh Kimi Code session id')
            } catch (err) {
              log.debug({ event: 'kimi.session.callback_failed', err: String(err) })
            }
          }
        }
      },
    }
  }

  protected extractText(event: unknown): string {
    const e = event as KimiEvent
    if (e.type === 'assistant' || e.role === 'assistant' || e.message?.role === 'assistant') {
      return contentText(e.message?.content ?? e.content) || e.text || e.delta?.text || e.delta?.content || ''
    }
    if (e.type === 'content_block_delta' || e.type === 'delta') {
      return e.delta?.text || e.text || ''
    }
    // Avoid double-emitting terminal result events when assistant messages
    // already carried the content.
    return ''
  }

  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as KimiEvent
    const sessionId = e.sessionId || e.session_id
    if (!opts.agentSessionId && opts.onAgentSessionId && typeof sessionId === 'string' && sessionId) {
      try { opts.onAgentSessionId(sessionId) } catch { /* best-effort */ }
    }
    if (opts.onUsage && e.usage) {
      const input = e.usage.input_tokens ?? e.usage.inputTokens
      const output = e.usage.output_tokens ?? e.usage.outputTokens
      const delta: { tokensInput?: number; tokensOutput?: number } = {}
      if (typeof input === 'number' && input > 0) delta.tokensInput = input
      if (typeof output === 'number' && output > 0) delta.tokensOutput = output
      if (delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
        try { opts.onUsage(delta) } catch { /* best-effort */ }
      }
    }
  }

  protected handleError(_code: number, stderr: string, errorMessage: string): string | null {
    const combined = `${stderr} ${errorMessage}`
    if (/unauthor|api key|login|log in|KIMI_API_KEY|MOONSHOT/i.test(combined)) {
      return [
        '🔐 Kimi Code 未登录 / 凭据缺失。',
        '   在装有 Kimi Code 的机器跑：`kimi`，按提示完成登录。',
        '   或按 Kimi Code 文档配置 KIMI_API_KEY / MOONSHOT_API_KEY。',
      ].join('\n')
    }
    return null
  }

  protected notAvailableMessage(): string {
    return (
      'Kimi Code CLI 未安装。安装：\n' +
      '  npm install -g @moonshot-ai/kimi-code\n' +
      '装完后跑一次 `kimi` 完成首次登录。'
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

export const kimiCodeAdapter = new KimiCodeAdapter()
