// Claude Code agent adapter
// Uses --print --output-format stream-json for programmatic interaction
//
// Permission flow has three modes, decided per-call in prepareCommand():
//
//   1. Skip-permissions opt-in (AGIM_DANGEROUSLY_SKIP_PERMISSIONS=1):
//        --dangerously-skip-permissions
//      Bypasses ALL permission checks — approval prompts, PreToolUse hooks,
//      everything. Mirrors the Claude CLI flag name 1:1 so the safety
//      tradeoff is obvious. Wins over every other branch below. Intended
//      for private / sandboxed deployments where the operator trusts every
//      message coming in over IM.
//
//   2. Approval-routed (default when IM context is present and the bus is up):
//        --permission-mode default
//        --permission-prompt-tool mcp__agim__request
//        --mcp-config <tmpfile>
//      The MCP sidecar (mcp-approval-server.js) is registered via
//      --mcp-config; it connects to agim's approval-bus over a unix
//      socket, and agim surfaces approval prompts to the originating
//      IM thread.
//
//   3. Legacy "dontAsk" fallback (env AGIM_APPROVAL_DISABLED=1, OR no IM
//      thread context, OR approvalBus not started, OR mcp-config write
//      fails):
//        --permission-mode dontAsk
//      Claude leans on PreToolUse hooks in ~/.claude/settings.json plus
//      the CLAUDE_VIA_IM env signal injected by agim.service. Less
//      drastic than mode 1 — hooks still gate tools when configured.
//
// IMPORTANT: every per-spawn resource (runId, mcp-config dir, registry
// entry) lives in the SpawnPlan returned by prepareCommand — never on the
// adapter instance. The adapter is a singleton and concurrent IM threads
// would otherwise clobber each other's state mid-spawn.

import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR_PATH = join(__dirname, 'mcp-approval-server.js')
const log = rootLogger.child({ component: 'agent.claude-code' })

const BASE_ARGS = ['--print', '--verbose', '--output-format', 'stream-json'] as const

/** v1.3.8 — token-level streaming. With `--include-partial-messages` the CLI
 *  emits `content_block_delta` / `text_delta` events as the model writes,
 *  instead of one whole text block per turn — so the TUI streams smoothly
 *  rather than landing a paragraph at a time. Default ON; set
 *  AGIM_CLAUDE_PARTIAL_STREAM=0 to fall back to block streaming (e.g. for an
 *  older Claude Code CLI that doesn't recognise the flag). */
export function claudePartialStreamEnabled(): boolean {
  return process.env.AGIM_CLAUDE_PARTIAL_STREAM !== '0'
}

/** BASE_ARGS plus the partial-message flag when enabled. Computed at call
 *  time so the env opt-out (and tests) take effect without a restart. */
function baseArgs(): string[] {
  return claudePartialStreamEnabled() ? [...BASE_ARGS, '--include-partial-messages'] : [...BASE_ARGS]
}

/** First call with a UUID: --session-id (creates the session under that id).
 *  Subsequent calls: --resume (continues from existing). Mixing them up gets
 *  you "Session ID already in use" or "session not found". */
function sessionFlag(opts: AgentSendOpts): string[] {
  if (!opts.agentSessionId) return []
  return opts.agentSessionResume
    ? ['--resume', opts.agentSessionId]
    : ['--session-id', opts.agentSessionId]
}

interface ClaudeEvent {
  type: string
  // 'stream_event' wrapper (only with --include-partial-messages): carries a
  // raw Anthropic streaming event. We use content_block_delta/text_delta.
  event?: {
    type?: string
    delta?: { type?: string; text?: string }
  }
  message?: {
    content: Array<{ type: string; text?: string; thinking?: string }>
    role: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  // 'result' event — the final summary line emitted by `claude --print
  // --output-format stream-json` once the run finishes. Claude Code CLI
  // 2.x+ includes total_cost_usd here (already priced per current Anthropic
  // rates including any cache hit/miss math). Older builds may only have
  // `usage`; we fall back to that and let upstream price it.
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export class ClaudeCodeAdapter extends AgentBase {
  readonly name = 'claude-code'
  readonly aliases = ['cc', 'claude', 'claudecode']
  readonly kind = 'cli' as const

  protected get commandName(): string { return 'claude' }

  /**
   * Legacy/fallback args — used when approval routing is disabled or not
   * applicable (no IM context, bus down, AGIM_APPROVAL_DISABLED=1).
   *
   * planMode override: when opts.planMode is true we hand claude
   * `--permission-mode plan` regardless of fallback path. plan is read-only
   * by design so the IM approval bus has nothing to gate, and dontAsk would
   * silently re-allow mutations the user explicitly opted out of.
   */
  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const mode = opts.planMode ? 'plan' : 'dontAsk'
    return [
      ...sessionFlag(opts),
      ...baseArgs(),
      '--permission-mode', mode,
      prompt,
    ]
  }

  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    // Cwd is computed once and shared by all return paths below — both the
    // approval-routed path and every fallback ("dontAsk", missing IM context,
    // tmpdir failure, etc.). Skipping cwd on the fallbacks would silently
    // demote those calls back to agim's "/" cwd and leak across memory.
    const cwd = resolveAgentCwd(this.name, opts)

    // Plan mode short-circuits the approval-bus pipeline: claude's `plan`
    // permission mode is strictly read-only, so there are no mutating tools
    // for the IM bridge to gate. Skipping the mcp-config tmpdir + bus run
    // registration also keeps cleanup trivial. buildArgs picks `--permission-mode plan`
    // when opts.planMode is true.
    //
    // Plan wins over AGIM_DANGEROUSLY_SKIP_PERMISSIONS: read-only mode
    // is still useful as an exploration step even when the operator has
    // turned skip-permissions on globally for normal runs.
    if (opts.planMode) {
      return { args: this.buildArgs(prompt, opts), cwd }
    }

    // Skip-permissions opt-in. Set by the operator (env / Safety toggle in
    // /settings) when they're OK with Claude running every tool with no
    // approval and no hooks. Mirrors the CLI flag name so grep-ability
    // is high.
    if (process.env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS === '1') {
      log.info({ event: 'claude.approval.skip_permissions' },
        'Claude run launched with --dangerously-skip-permissions (operator opt-in)')
      return {
        args: [
          ...sessionFlag(opts),
          ...baseArgs(),
          '--dangerously-skip-permissions',
          prompt,
        ],
        cwd,
      }
    }

    if (process.env.AGIM_APPROVAL_DISABLED === '1') {
      return { args: this.buildArgs(prompt, opts), cwd }
    }

    const sockPath = approvalBus.getSocketPath()
    if (!sockPath) return { args: this.buildArgs(prompt, opts), cwd } // bus not started

    const { threadId, platform, channelId, userId } = opts
    if (!threadId || !platform || !channelId) {
      // Non-IM call (web/scheduler/intent-llm) — no thread to route prompts to.
      // resolveAgentCwd returns undefined here too, so cwd ends up undefined and
      // the spawn inherits agim's cwd, matching the historical behavior.
      return { args: this.buildArgs(prompt, opts), cwd }
    }

    const runId = randomUUID()

    let configDir: string
    try {
      configDir = await mkdtemp(join(tmpdir(), 'agim-mcp-'))
    } catch (err) {
      log.warn({ event: 'claude.approval.mkdtemp_failed', err: String(err) },
        'Falling back to dontAsk: cannot create mcp-config tmpdir')
      return { args: this.buildArgs(prompt, opts), cwd }
    }
    const configPath = join(configDir, 'mcp.json')

    const config = {
      mcpServers: {
        agim: {
          command: process.execPath,
          args: [SIDECAR_PATH],
          env: {
            AGIM_APPROVAL_SOCK: sockPath,
            AGIM_RUN_ID: runId,
          },
        },
      },
    }

    try {
      await writeFile(configPath, JSON.stringify(config), 'utf8')
    } catch (err) {
      log.warn({ event: 'claude.approval.write_config_failed', err: String(err) },
        'Falling back to dontAsk: cannot write mcp-config')
      try { await rm(configDir, { recursive: true, force: true }) } catch { /* ignore */ }
      return { args: this.buildArgs(prompt, opts), cwd }
    }

    approvalBus.registerRun(runId, {
      threadId, platform, userId: userId ?? '', channelId,
      callerAgent: this.name,
      // A2A-L1: forward parent + depth so any mcp__agim__call_agent
      // invocation from inside this run can be linked + depth-checked.
      ...(typeof opts.parentJobId === 'number' ? { parentJobId: opts.parentJobId } : {}),
      ...(typeof opts.callDepth === 'number' ? { callDepth: opts.callDepth } : {}),
      // SEC: forward plan-mode so a call_agent from inside this run can't
      // escalate the callee to write access. (claude-code's plan path
      // short-circuits before here today, but keep it for defense-in-depth.)
      ...(opts.planMode ? { callerPlanMode: true } : {}),
    })

    log.info({ event: 'claude.approval.routed', runId, threadId, platform },
      'Claude run routed via approval-bus')

    // Closure captures runId + configDir locally — concurrent runs each have
    // their own copy, so cleanup never deletes another spawn's tmpdir.
    return {
      args: [
        ...sessionFlag(opts),
        // ORDER MATTERS: --mcp-config takes <configs...> (variadic). Place it
        // before another `-X` flag so it sees exactly one file path, not the
        // prompt as a second config file.
        '--mcp-config', configPath,
        ...baseArgs(),
        '--permission-mode', 'default',
        '--permission-prompt-tool', 'mcp__agim__request',
        prompt,
      ],
      cwd,
      cleanup: async () => {
        approvalBus.unregisterRun(runId)
        try { await rm(configDir, { recursive: true, force: true }) } catch { /* ignore */ }
      },
    }
  }

  protected extractText(event: unknown): string {
    const msg = event as ClaudeEvent
    // Partial streaming: emit token-level text deltas as they arrive.
    if (msg.type === 'stream_event') {
      const ev = msg.event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        return ev.delta.text ?? ''
      }
      return ''  // ignore thinking_delta / input_json_delta / block start/stop
    }
    if (msg.type === 'assistant' && msg.message?.content) {
      // When partial streaming is on, the consolidated `assistant` block
      // repeats text already emitted via stream_event deltas — skip it to
      // avoid printing the message twice.
      if (claudePartialStreamEnabled()) return ''
      const parts: string[] = []
      for (const item of msg.message.content) {
        if (item.type === 'text' && item.text) parts.push(item.text)
      }
      return parts.join('')
    }
    return ''
  }

  /**
   * v1.3 — surface Claude Code's own cost + token usage so the audit-log
   * actually records non-zero numbers for claude invocations. Claude Code
   * CLI 2.x emits a `result` event at the end of each run with
   * `total_cost_usd` (already priced) and `usage` (token counts). We pipe
   * both through `opts.onUsage`, which the router accumulates and writes
   * into invocations.cost.
   */
  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    if (!opts.onUsage) return
    const e = event as ClaudeEvent
    if (e.type !== 'result') return
    const delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number } = {}
    if (typeof e.total_cost_usd === 'number' && Number.isFinite(e.total_cost_usd) && e.total_cost_usd >= 0) {
      delta.costUsd = e.total_cost_usd
    }
    const usage = e.usage
    if (usage) {
      const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
      const cacheCreate = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
      const rawInput = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      const totalInput = rawInput + cacheRead + cacheCreate
      if (totalInput > 0) delta.tokensInput = totalInput
      if (typeof usage.output_tokens === 'number' && usage.output_tokens > 0) {
        delta.tokensOutput = usage.output_tokens
      }
    }
    if (delta.costUsd !== undefined || delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
      try { opts.onUsage(delta) } catch { /* never propagate callback errors */ }
    }
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter()

// Test-only escape hatch — drives prepareCommand/buildArgs without going
// through the spawnStream pipeline.
export const _testInternals = {
  async prepareCommand(adapter: ClaudeCodeAdapter, prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    // @ts-expect-error — protected; tests reach in deliberately
    return adapter.prepareCommand(prompt, opts)
  },
  buildArgs(adapter: ClaudeCodeAdapter, prompt: string, opts: AgentSendOpts = {}): string[] {
    // @ts-expect-error
    return adapter.buildArgs(prompt, opts)
  },
  extractText(adapter: ClaudeCodeAdapter, event: unknown): string {
    // @ts-expect-error — protected; tests reach in deliberately
    return adapter.extractText(event)
  },
}
