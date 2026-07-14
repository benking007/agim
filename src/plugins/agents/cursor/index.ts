// Cursor (`cursor-agent`) agent adapter.
//
// CLI surface (observed from `cursor-agent --help` on v2026.05.20+):
//   cursor-agent [flags] [prompt...]              # interactive if TTY
//   cursor-agent --print "<prompt>"               # headless single-shot
//   cursor-agent --print --output-format stream-json "<prompt>"
//     ↓
//     newline-delimited events: system.init, user, assistant, tool_call,
//     result. Each event carries `session_id` (constant throughout a run).
//   cursor-agent --print --resume <chatId> ...    # resume an existing chat
//   cursor-agent --print --continue ...           # resume the most recent
//   cursor-agent --print --plan ...               # plan mode (read-only)
//   cursor-agent --print --mode ask ...           # Q&A mode (read-only)
//   cursor-agent --print --model <id> ...         # override model
//   cursor-agent create-chat                      # pre-create a chat, get id
//
// Permissions model:
//   - cursor reads MCP servers from `~/.cursor/mcp.json` (global) or
//     `.cursor/mcp.json` (per-workspace). On adapter init we write the
//     global file with an `agim` entry pointing at the shared MCP sidecar
//     (the same one claude-code uses). Subsequent tool calls hop through
//     agim's approval-bus exactly like claude-code's.
//   - `--approve-mcps` auto-approves MCP servers (no per-launch prompt;
//     individual `mcp__agim__*` calls still gate on agim's approval-bus).
//   - `--force` (alias `--yolo`) bypasses cursor's own per-tool confirmation
//     for shell / write / delete actions. Required for headless IM use —
//     there's no interactive TTY to answer prompts. Operators can still
//     deny via agim policy or by editing `~/.cursor/cli-config.json`'s
//     `permissions.deny` array.
//   - `--trust` marks the workspace as trusted; otherwise cursor refuses
//     to start in `--print` mode against an unknown directory.
//
// Session lifecycle:
//   - First call: spawn without `--resume`. The first event we see on
//     stdout is `system.init` which carries `session_id`. inspectEvent
//     calls `opts.onAgentSessionId(id)` so cli persists it on the agim
//     Session row.
//   - Subsequent calls: spawn with `--resume <session_id>`. cursor
//     reopens the chat and appends the new turn.
//   - `/new` clears the agim session row's cursor id; next run starts
//     fresh.
//
// Authentication:
//   - cursor stores credentials at `~/.cursor/cli-config.json` after
//     `cursor-agent login`. agim runs as the same user, so the file is
//     readable out of the box — no env-var dance needed. Set
//     CURSOR_API_KEY env if the operator prefers a token over OAuth.
//
// Default model:
//   - We respect whatever is set in `~/.cursor/cli-config.json`'s
//     `model.modelId`. Operators override per-call via `opts.model` (e.g.
//     `/cs model sonnet-4-thinking <prompt>`) or globally via cli-config.

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { crossSpawn } from '../../../utils/cross-platform.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { ensureAgimMcp } from './ensure-mcp-config.js'

const log = rootLogger.child({ component: 'agent.cursor' })

const DEFAULT_BIN = 'cursor-agent'

/** Path to the agim MCP sidecar JS file. Shared with claude-code /
 *  antigravity — the protocol surface is host-agnostic. */
function sidecarPath(): string {
  // From dist/plugins/agents/cursor/index.js the sidecar is at:
  //   ../claude-code/mcp-approval-server.js
  return new URL('../claude-code/mcp-approval-server.js', import.meta.url).pathname
}

/** Subset of the stream-json event shape we read. */
interface CursorEvent {
  type?: string
  subtype?: string
  session_id?: string
  message?: {
    role?: string
    content?: Array<{ type?: string; text?: string }>
  }
  result?: string
  duration_ms?: number
  duration_api_ms?: number
  is_error?: boolean
  /** Present on `result` events in cursor-agent 2026.05+. */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}

export class CursorAdapter extends AgentBase {
  readonly name = 'cursor'
  readonly aliases = ['cs', 'cur']
  readonly kind = 'cli' as const

  /** Cached bin path resolution. null = "haven't probed";
   *  undefined = "probed, not found, fall back to bare name". */
  private resolvedBin: string | null | undefined = null

  /** Have we written the agim MCP entry to ~/.cursor/mcp.json yet this
   *  agim process lifetime? Saves the disk hit on every send. Reset on
   *  agim restart so the next run rewrites with the fresh socket path. */
  private mcpReady = false

  protected get commandName(): string {
    const override = process.env.AGIM_CURSOR_BIN
    if (override) return override
    if (this.resolvedBin !== null) return this.resolvedBin ?? DEFAULT_BIN

    // The official installer puts the bin at `~/.local/bin/cursor-agent`
    // (XDG user-local). systemd-launched agim doesn't source the user's
    // shell rc, so PATH lookup of bare `cursor-agent` often fails even
    // when the binary is right there. Probe the known locations.
    const candidates = [
      join(homedir(), '.local', 'bin', 'cursor-agent'),
      '/usr/local/bin/cursor-agent',
      '/opt/cursor/bin/cursor-agent',
    ]
    for (const p of candidates) {
      try {
        const s = statSync(p)
        if (s.isFile() && (s.mode & 0o111) !== 0) {
          this.resolvedBin = p
          log.info({ event: 'cursor.bin.resolved', path: p }, 'resolved cursor-agent outside PATH')
          return p
        }
      } catch { /* not here */ }
    }
    this.resolvedBin = undefined
    return DEFAULT_BIN
  }

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const args: string[] = ['--print', '--output-format', 'stream-json']
    // Trust + force are mandatory for headless IM use — cursor refuses
    // to write / shell otherwise and there's no TTY to answer prompts.
    // Operators wanting tighter control can use AGIM_NATIVE_AGENT_DENYLIST
    // for agim tools and edit `~/.cursor/cli-config.json`'s `permissions.deny`
    // for cursor-side tool gating.
    args.push('--trust', '--force', '--approve-mcps')
    if (opts.model) args.push('--model', opts.model)
    if (opts.planMode) args.push('--plan')
    if (opts.agentSessionId && !opts.agentSessionResume) {
      // First call with this session id — cursor doesn't have a
      // "--session-id <new>" form like claude-code; the session id is
      // assigned by cursor and surfaced in system.init. Treat
      // pre-supplied id as a resume hint.
      args.push('--resume', opts.agentSessionId)
    } else if (opts.agentSessionId) {
      args.push('--resume', opts.agentSessionId)
    }
    args.push(prompt)
    return args
  }

  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    let cwd = resolveAgentCwd(this.name, opts)
    if (cwd) {
      try {
        if (!existsSync(cwd)) await mkdir(cwd, { recursive: true })
      } catch (err) {
        log.warn({ event: 'cursor.cwd.mkdir_failed', cwd, err: String(err) },
          'falling back to inherited cwd because workspace dir could not be created')
        cwd = undefined
      }
    }

    // Append cwd to --workspace so cursor scopes file ops to the per-agent
    // workspace instead of the systemd cwd ("/").
    const baseArgs = this.buildArgs(prompt, opts)
    if (cwd) {
      // Insert before the prompt (last arg). Order matters for cursor's
      // commander parser — flags before positional.
      const promptArg = baseArgs.pop() as string
      baseArgs.push('--workspace', cwd, promptArg)
    }

    // MCP wiring (one-shot per agim process lifetime).
    const sockPath = approvalBus.getSocketPath()
    if (sockPath && !this.mcpReady) {
      try {
        await ensureAgimMcp({
          command: process.execPath,
          args: [sidecarPath()],
          env: { AGIM_APPROVAL_SOCK: sockPath },
        })
        this.mcpReady = true
      } catch (err) {
        log.warn({ event: 'cursor.mcp.disabled', err: String(err) },
          'agim MCP not wired into cursor — agim tools will be invisible to cursor this run')
      }
    }

    // approval-bus registration so mcp__agim__* tool calls inside the
    // cursor run resolve to this IM thread.
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
        // SEC: forward plan-mode so a call_agent from inside this run can't
        // launch the callee with full write access.
        ...(opts.planMode ? { callerPlanMode: true } : {}),
        ...(opts.onToolActivity ? { onToolActivity: opts.onToolActivity } : {}),
      })
      registered = true
      log.info({ event: 'cursor.approval.routed', runId, threadId, platform },
        'cursor run routed via approval-bus')
    }

    return {
      args: baseArgs,
      cwd,
      extraEnv: {
        AGIM_RUN_ID: runId,
        // cursor reads CURSOR_API_KEY if set; otherwise falls back to
        // OAuth creds in ~/.cursor/cli-config.json. Pass HOME through
        // so systemd-stripped env doesn't break the credential lookup.
        HOME: process.env.HOME || homedir(),
      },
      cleanup: async () => {
        if (registered) approvalBus.unregisterRun(runId)
      },
    }
  }

  /** Pull the assistant text from a single stream-json event. */
  protected extractText(event: unknown): string {
    const e = event as CursorEvent
    if (e.type === 'assistant' && e.message?.content) {
      const parts: string[] = []
      for (const item of e.message.content) {
        if (item.type === 'text' && item.text) parts.push(item.text)
      }
      return parts.join('')
    }
    // The terminal `result` event carries the aggregated final answer.
    // We don't double-emit it (assistant events already covered the
    // text); but if the stream skipped intermediate assistant events for
    // some reason, result.result is the fallback.
    return ''
  }

  /** Capture `session_id` from system.init AND token usage from result
   *  events so cli persists session resume + audit log records cost
   *  (well, tokens — cursor doesn't price client-side). */
  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as CursorEvent
    if (e.type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string') {
      // Only surface if the caller didn't already pin one — saves a
      // pointless SQLite write when resuming an existing session.
      if (!opts.agentSessionId && opts.onAgentSessionId) {
        try {
          opts.onAgentSessionId(e.session_id)
          log.info({ event: 'cursor.session.captured', id: e.session_id }, 'captured fresh cursor session id')
        } catch (err) {
          log.debug({ event: 'cursor.session.callback_failed', err: String(err) })
        }
      }
    }
    if (e.type === 'result' && opts.onUsage && e.usage) {
      const u = e.usage
      const cacheRead = typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
      const cacheWrite = typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0
      const rawInput = typeof u.inputTokens === 'number' ? u.inputTokens : 0
      const tokensInput = rawInput + cacheRead + cacheWrite
      const tokensOutput = typeof u.outputTokens === 'number' ? u.outputTokens : 0
      const delta: { tokensInput?: number; tokensOutput?: number } = {}
      if (tokensInput > 0) delta.tokensInput = tokensInput
      if (tokensOutput > 0) delta.tokensOutput = tokensOutput
      if (delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
        try { opts.onUsage(delta) } catch { /* best-effort */ }
      }
      // cursor doesn't surface USD cost client-side; operators see it on
      // cursor.com/dashboard. costUsd stays unset for cursor turns.
    }
  }

  protected handleError(_code: number, stderr: string, errorMessage: string): string | null {
    const combined = `${stderr} ${errorMessage}`
    if (/unauthor|sign in|log in|CURSOR_API_KEY/i.test(combined)) {
      return [
        '🔐 Cursor 未登录 / 凭据过期。',
        '   在装有 cursor-agent 的机器跑：`cursor-agent login`',
        '   或设环境变量 CURSOR_API_KEY=<your-key>',
      ].join('\n')
    }
    return null
  }

  protected notAvailableMessage(): string {
    return (
      'Cursor CLI 未安装。安装：\n' +
      '  curl https://cursor.com/install -fsS | bash\n' +
      '装完后跑一次 `cursor-agent login` 完成首次登录。'
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

export const cursorAdapter = new CursorAdapter()
