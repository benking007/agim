// OpenAI Codex CLI agent adapter — `codex exec --json` driver.
//
// Multi-turn continuity (mirrors the opencode pattern):
//
//   First turn  — no opts.agentSessionId yet. Spawn `codex exec --json …`.
//                 The adapter watches for `thread.started.thread_id` and
//                 reports it back via opts.onAgentSessionId so cli persists
//                 it on the agim Session row (codexSessionId).
//   Later turns — opts.agentSessionId is the captured UUID. We spawn
//                 `codex exec resume <id> --json …` so codex continues from
//                 its own ~/.codex/sessions store. router.callAgentWithHistory
//                 honours agentSessionResume by zeroing effectiveHistory so
//                 we don't double-feed prior turns.
//
// Cwd: pinned to ~/.agim-workspaces/codex/ for IM calls (per agent-cwd.ts);
// codex reads its project AGENTS.md from cwd just like opencode.
//
// Usage roll-up: `turn.completed.usage` carries token counts (no cost). We
// forward input/output tokens via opts.onUsage so /stats reflects real codex
// usage. costUsd stays undefined until codex surfaces pricing.
//
// Approval / sandbox model (current):
//   - `codex exec` has NO external approval hook (no --ask-for-approval
//     equivalent). Confirmed against codex CLI 0.x — only `-s` sandbox
//     mode + `--dangerously-bypass-approvals-and-sandbox` exist. So we
//     CANNOT route per-tool approvals through approval-bus the way
//     claude-code (MCP sidecar) and opencode (SSE bus) do.
//   - Best we can do today: pin sandbox to `workspace-write` by default
//     (cwd-scoped writes only, NO auto-approval — codex's internal policy
//     decides each call), and flip to `read-only` when session.planMode
//     is on. This gives us a "safety floor" rather than a true gate.
//   - True per-tool approval would require running codex via `codex
//     mcp-server` (stdio MCP) and putting our own approval-bus shim
//     between the MCP client and codex. Tracked as a future iteration.
//
// MCP agim sidecar (v0.4.0):
//   - When IM context is present and approvalBus is up, prepareCommand
//     injects `-c mcp_servers.agim.{command,args,env}=...` ahead of the
//     `exec` subcommand. codex spawns the sidecar as a stdio MCP child
//     and the model gets access to the 9 agim tools (reminder + memo +
//     request_location_capture). The `request` approval-prompt tool is
//     exposed too but codex has no `--permission-prompt-tool` knob, so
//     codex won't auto-invoke it; it's harmless to include.
//   - Per-spawn runId is set on the bus and passed via the MCP env table,
//     so reminder.* RPCs route back to the originating IM thread.
//   - No write to ~/.codex/config.toml — inline -c args merge over the
//     persisted config for this invocation only. The user's hand-edited
//     toml is left alone.

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { crossSpawn } from '../../../utils/cross-platform.js'
import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { buildCodexMcpCliArgs } from './build-mcp-cli-args.js'

const log = rootLogger.child({ component: 'agent.codex' })

/**
 * Codex's `bin/codex.js` wrapper (npm install -g @openai/codex) drops all
 * stdout when the parent spawns it with `stdio: ['ignore', 'pipe', 'pipe']`
 * — the wrapper relays its own stdio to the native binary via
 * `stdio: 'inherit'`, and that handoff fails to forward data through a
 * piped fd back to the grandparent. The native binary works fine when
 * called directly.
 *
 * Resolution: at startup, follow `which codex` → real path of wrapper →
 * `<codex-pkg>/node_modules/@openai/codex-<triple>/vendor/<triple>/codex/codex`.
 * Cache the result. If anything in the chain is missing (different install
 * layout, unsupported triple), fall back to the wrapper name and hope for
 * the best — at least the user sees a failure rather than silent 0-byte.
 *
 * Probed once per process; the cache lives module-level.
 */
let cachedBinary: string | null = null
let probed = false

/** v1.2.143 — invalidate the binary cache so the next call re-probes
 *  from scratch. Used when a previously cached path turns up missing
 *  (ENOENT on spawn) — e.g. operator upgraded codex while agim was
 *  running and the old vendor dir got deleted. Exported for tests and
 *  for the ENOENT-recovery path inside `isAvailable`. */
export function resetCodexBinaryCache(): void {
  cachedBinary = null
  probed = false
}

function resolveCodexBinary(): string {
  if (probed) return cachedBinary ?? 'codex'
  probed = true

  try {
    const wrapper = execSync('command -v codex', { encoding: 'utf8' }).trim()
    if (!wrapper) return 'codex'

    const wrapperReal = realpathSync(wrapper)
    // wrapperReal e.g. /usr/local/lib/node_modules/@openai/codex/bin/codex.js
    const codexPkgRoot = dirname(dirname(wrapperReal))

    const triple = pickTriple(process.platform, process.arch)
    if (!triple) {
      log.warn({ platform: process.platform, arch: process.arch },
        'codex: unsupported platform, falling back to wrapper (stdio pipe bug applies)')
      return 'codex'
    }

    const platformPkg = pickPlatformPackage(process.platform, process.arch)
    if (!platformPkg) return 'codex'

    // v1.2.143 — codex 0.137 changed the vendor sub-layout from
    // `vendor/<triple>/codex/codex` to `vendor/<triple>/bin/codex`.
    // Probe the new path first; keep the old path as a fallback so
    // operators still on codex ≤ 0.136 don't regress.
    const candidates = [
      // codex >= 0.137 new layout
      join(codexPkgRoot, 'node_modules', platformPkg, 'vendor', triple, 'bin', 'codex'),
      join(codexPkgRoot, 'vendor', triple, 'bin', 'codex'),
      // codex <= 0.136 legacy layout
      join(codexPkgRoot, 'node_modules', platformPkg, 'vendor', triple, 'codex', 'codex'),
      join(codexPkgRoot, 'vendor', triple, 'codex', 'codex'),
    ]
    for (const cand of candidates) {
      if (existsSync(cand)) {
        cachedBinary = cand
        log.info({ binary: cand }, 'codex: resolved native binary, bypassing wrapper')
        return cand
      }
    }
    log.warn({ tried: candidates }, 'codex: native binary not found, using wrapper (may break in IM)')
  } catch (err) {
    log.warn({ err: String(err) }, 'codex: binary resolution failed, using wrapper')
  }
  return 'codex'
}

function pickTriple(platform: string, arch: string): string | null {
  if (platform === 'linux') {
    if (arch === 'x64')   return 'x86_64-unknown-linux-musl'
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl'
  }
  if (platform === 'darwin') {
    if (arch === 'x64')   return 'x86_64-apple-darwin'
    if (arch === 'arm64') return 'aarch64-apple-darwin'
  }
  if (platform === 'win32') {
    if (arch === 'x64')   return 'x86_64-pc-windows-msvc'
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc'
  }
  return null
}

function pickPlatformPackage(platform: string, arch: string): string | null {
  const archKey = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  if (!archKey) return null
  if (platform === 'linux')  return `@openai/codex-linux-${archKey}`
  if (platform === 'darwin') return `@openai/codex-darwin-${archKey}`
  if (platform === 'win32')  return `@openai/codex-win32-${archKey}`
  return null
}

interface CodexEvent {
  type: string
  thread_id?: string
  item?: {
    id?: string
    type?: string
    text?: string
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
    reasoning_output_tokens?: number
  }
  message?: string
  error?: string
  error_message?: string
}

/**
 * Common flags every spawn carries. Sandbox mode is intentionally absent
 * here — it's added per-spawn by buildArgs based on opts.planMode so plan
 * runs go read-only and normal runs land at workspace-write.
 *
 * Why not `--full-auto`?  --full-auto = `-s workspace-write` + auto-approval
 * of every internal prompt. That's stronger than we want for an IM-driven
 * agent — codex's own policy engine can still ask the user "do this risky
 * thing?" and we'd rather see those prompts surface (codex emits them as
 * `turn.message` events on the JSON stream) than have them silently
 * answered yes. workspace-write WITHOUT --full-auto preserves codex's
 * internal decisioning while keeping the OS-level write fence.
 */
const BASE_FLAGS = ['--json', '--skip-git-repo-check'] as const

export class CodexAdapter extends AgentBase {
  readonly name = 'codex'
  readonly aliases = ['cx', 'openai', 'codexcli']
  readonly kind = 'cli' as const

  /**
   * Override to bypass the codex wrapper's broken stdio handling — see
   * resolveCodexBinary() above. Falls back to "codex" (PATH lookup) if
   * native binary resolution fails.
   *
   * commandName drives `isAvailable()` (--version probe) AND the spawn binary,
   * so resolving here gets us both at once.
   */
  protected get commandName(): string {
    return resolveCodexBinary()
  }

  /**
   * v1.2.143 — override the default `--version` probe so that a stale
   * cached path (e.g. operator upgraded codex while agim was running
   * and the old vendor dir got deleted) self-heals: ENOENT triggers a
   * cache reset + one re-probe before reporting unavailable.
   *
   * Why: AgentBase's default isAvailable spawns commandName which goes
   * through `resolveCodexBinary` → cachedBinary. If cachedBinary points
   * at a deleted file, spawn errors with ENOENT every call until
   * restart. The settings/agents UI shows "未就绪" indefinitely even
   * though the operator's actual codex install is fine.
   */
  override async isAvailable(): Promise<boolean> {
    const tryOnce = (): Promise<{ ok: boolean; code?: string }> => new Promise((resolve) => {
      const proc = crossSpawn(this.commandName, ['--version'], { stdio: 'ignore' })
      proc.on('close', (code: number | null) => resolve({ ok: code === 0 }))
      proc.on('error', (err: NodeJS.ErrnoException) => resolve({
        ok: false,
        code: err.code,
      }))
    })
    const first = await tryOnce()
    if (first.ok) return true
    if (first.code === 'ENOENT') {
      log.warn({ binary: this.commandName }, 'codex: cached binary missing (ENOENT); resetting cache and re-probing')
      resetCodexBinaryCache()
      const second = await tryOnce()
      return second.ok
    }
    return false
  }

  /**
   * Build the codex argv WITHOUT MCP -c flags. prepareCommand prepends MCP
   * args separately so the order is: `<-c global flags...> exec [resume <id>]
   * <exec flags...> <prompt>`. Codex's clap requires global flags ahead of
   * the subcommand, and the prompt has to be the trailing positional.
   */
  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    // session.planMode → -s read-only sandbox. Best-available approximation
    // of "agent only plans, doesn't act"; codex still emits write attempts
    // as events but the OS layer rejects them. See file header for the
    // approval-model discussion.
    //
    // `-s/--sandbox` is ONLY valid on the initial `exec` invocation. The
    // `exec resume` subcommand (codex 0.130+) inherits the sandbox policy
    // from the original session and rejects `-s` with "unexpected argument".
    // So we splice sandboxFlags onto fresh starts only.
    //
    // MCP tool approval: codex's MCP integration auto-cancels every tool
    // call in non-interactive (`exec --json`) mode because there's no TUI
    // to render the approval prompt. Result: every agim_save_memo/etc.
    // call returns `"user cancelled MCP tool call"` and the model gives up.
    // The ONLY way codex 0.130 lets MCP calls through non-interactively is
    // `--dangerously-bypass-approvals-and-sandbox` which also disables the
    // sandbox layer.
    //
    // Trade-off: IM-spawned codex gains agim MCP tool access at the cost
    // of the workspace-write sandbox. Acceptable for our use because:
    //   - the IM user IS the same trust principal as the host
    //   - codex never had per-tool approval cards in agim anyway (no CLI
    //     hook; it always ran bash/edit autonomously within sandbox)
    //   - users who want sandbox back can set AGIM_CODEX_SAFE_MODE=1, at
    //     the cost of MCP tools being unusable
    // planMode users similarly fall back to safe-mode (`-s read-only` only,
    // no bypass) because plan runs shouldn't be acting anyway.
    const wantBypass =
      process.env.AGIM_CODEX_SAFE_MODE !== '1' &&
      !opts.planMode &&
      process.env.AGIM_APPROVAL_DISABLED !== '1'
    const sandboxMode = opts.planMode ? 'read-only' : 'workspace-write'
    if (opts.agentSessionId && opts.agentSessionResume) {
      // `codex exec resume <UUID> [OPTIONS] [PROMPT]` — SESSION_ID is a
      // positional immediately after `resume`. No -s here (resume inherits
      // sandbox from original session).
      const flags = wantBypass ? ['--dangerously-bypass-approvals-and-sandbox'] : []
      return ['exec', 'resume', opts.agentSessionId, ...BASE_FLAGS, ...flags, prompt]
    }
    const sandboxFlags = wantBypass
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['-s', sandboxMode]
    return ['exec', ...BASE_FLAGS, ...sandboxFlags, prompt]
  }

  /**
   * codex reads its project-level AGENTS.md from spawn cwd, so for IM calls we
   * pin to ~/.agim-workspaces/codex/. Non-IM calls (web/scheduler) keep
   * cwd undefined and inherit agim's cwd. See agent-cwd.ts for rationale.
   *
   * MCP sidecar injection: when we have an IM thread + the bus is up, prepend
   * `-c mcp_servers.agim.{command,args,env}=...` to register the agim MCP
   * sidecar for this invocation only. The runId env entry is registered on
   * the bus first so reminder.* RPCs from the sidecar route back to the
   * correct RunContext. Cleanup unregisters the runId after the spawn exits.
   *
   * Fallback path (no IM context, bus down, or AGIM_APPROVAL_DISABLED=1):
   * just buildArgs(prompt, opts) — codex still works, just without agim
   * MCP tools. Matches the existing claude-code/opencode fallback shape.
   */
  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    const cwd = resolveAgentCwd(this.name, opts)
    const baseArgs = this.buildArgs(prompt, opts)

    if (process.env.AGIM_APPROVAL_DISABLED === '1') {
      return { args: baseArgs, cwd }
    }

    const sockPath = approvalBus.getSocketPath()
    const { threadId, platform, channelId, userId } = opts
    if (!sockPath || !threadId || !platform || !channelId) {
      // Non-IM call (web/scheduler/intent-llm) OR bus not started yet —
      // run codex without registering the MCP sidecar. The reminder tools
      // wouldn't have a thread to address anyway.
      return { args: baseArgs, cwd }
    }

    const runId = randomUUID()
    const mcpArgs = buildCodexMcpCliArgs({ sockPath, runId })

    approvalBus.registerRun(runId, {
      threadId, platform, userId: userId ?? '', channelId,
      callerAgent: this.name,
      // A2A-L1: forward parent + depth so any mcp__agim__call_agent
      // invocation from inside this run can be linked + depth-checked.
      ...(typeof opts.parentJobId === 'number' ? { parentJobId: opts.parentJobId } : {}),
      ...(typeof opts.callDepth === 'number' ? { callDepth: opts.callDepth } : {}),
      // SEC: forward plan-mode so a call_agent from inside this read-only run
      // can't launch the callee with full write access.
      ...(opts.planMode ? { callerPlanMode: true } : {}),
    })
    log.info({ event: 'codex.mcp.run_registered', runId, threadId, platform },
      'Codex run registered with bus for agim MCP tools')

    return {
      // -c flags belong BEFORE `exec`; baseArgs starts with `exec` so the
      // simple prefix-splice is correct.
      args: [...mcpArgs, ...baseArgs],
      cwd,
      cleanup: () => {
        approvalBus.unregisterRun(runId)
      },
    }
  }

  protected extractText(event: unknown): string {
    const e = event as CodexEvent
    // codex 0.128 emits assistant text inside item.completed where item.type
    // is "agent_message". The pre-v1 adapter looked for {type:"message"},
    // which never fires, so all output was being dropped on the floor.
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
      return e.item.text
    }
    return ''
  }

  /**
   * Side-channel hook: capture session id (`thread.started`) and usage
   * (`turn.completed.usage`) without disrupting the text stream.
   */
  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as CodexEvent
    if (e.type === 'thread.started' && e.thread_id && opts.onAgentSessionId) {
      try { opts.onAgentSessionId(e.thread_id) } catch { /* userland callback safety */ }
    }
    if (e.type === 'turn.completed' && e.usage && opts.onUsage) {
      const u = e.usage
      const delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number } = {}
      if (typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens)) {
        delta.tokensInput = u.input_tokens
      }
      if (typeof u.output_tokens === 'number' && Number.isFinite(u.output_tokens)) {
        delta.tokensOutput = u.output_tokens
      }
      // codex doesn't surface cost; leave delta.costUsd undefined.
      if (delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
        try { opts.onUsage(delta) } catch { /* userland callback safety */ }
      }
    }
  }

  protected handleError(_code: number, _stderr: string, errorMessage: string): string | null {
    if (errorMessage.includes('expired') || errorMessage.includes('过期')) {
      return '❌ Codex 账号已过期\n\n请运行 `codex login` 重新登录。'
    }
    if (errorMessage.includes('not found') || errorMessage.includes('不存在')) {
      return '❌ Codex 用户不存在，请重新登录\n\n请运行 `codex login` 重新登录。'
    }
    return null
  }
}

export const codexAdapter = new CodexAdapter()

// Test-only escape hatch — drives the protected hooks without going through
// the spawnStream pipeline.
export const _testInternals = {
  buildArgs(adapter: CodexAdapter, prompt: string, opts: AgentSendOpts = {}): string[] {
    // @ts-expect-error — protected; tests reach in deliberately
    return adapter.buildArgs(prompt, opts)
  },
  async prepareCommand(adapter: CodexAdapter, prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    // @ts-expect-error
    return adapter.prepareCommand(prompt, opts)
  },
  extractText(adapter: CodexAdapter, event: unknown): string {
    // @ts-expect-error
    return adapter.extractText(event)
  },
  inspectEvent(adapter: CodexAdapter, event: unknown, opts: AgentSendOpts): void {
    // @ts-expect-error
    adapter.inspectEvent(event, opts)
  },
}
