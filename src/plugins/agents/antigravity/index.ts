// Antigravity (Google `agy`) agent adapter.
//
// CLI surface (observed from `agy --help` on 1.x):
//   agy [flags] [prompt]                      # interactive if TTY, else prints
//   agy --print "<prompt>"                    # single-shot, prints reply
//   agy --print --conversation <uuid> "..."   # resume an existing conversation
//   agy --print --continue "..."              # resume the most recent one
//   agy --dangerously-skip-permissions ...    # auto-approve every tool call
//   agy --add-dir <path>                      # add workspace dir (repeatable)
//   agy --print-timeout 30m                   # cap server wait
//
// Permissions model:
//   - agy reads MCP servers from ~/.gemini/config/mcp_config.json (the
//     shared Gemini-family location). agim's `imhub` MCP sidecar registers
//     itself there via ensure-mcp-config; subsequent tool calls hop through
//     the same approval-bus that claude-code / codex / opencode share.
//   - For non-IM call paths (web/scheduler/intent-llm) we don't have a
//     thread to surface approval cards to. We could fall back to
//     `--dangerously-skip-permissions`, but defer that until an operator
//     asks for it — for now the run will block on the first tool call,
//     same as the other adapters in non-IM mode.
//
// Session lifecycle:
//   - First call: launch `agy --print "<prompt>"`. agy creates a new
//     conversation UUID under ~/.gemini/antigravity-cli/conversations/<uuid>.pb
//     and prints its reply to stdout. We don't see the UUID in stdout —
//     instead we read it from disk by listing that directory and picking the
//     most recently-modified .pb file (the one we just created). Then stash
//     it on Session.antigravitySessionId.
//   - Subsequent calls: launch `agy --print --conversation <uuid> "<prompt>"`.
//     agy reopens the .pb and appends turns.
//   - `/new` clears antigravitySessionId; the next run starts fresh.
//
// Output format:
//   agy prints plain text to stdout (not JSON stream). The AgentBase
//   spawnStream path falls back to passing non-JSON lines through verbatim,
//   so extractText() just returns '' here and lets the base loop forward
//   stdout. inspectEvent is unused for the same reason.

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { crossSpawn } from '../../../utils/cross-platform.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { ensureImhubMcp } from './ensure-mcp-config.js'

const log = rootLogger.child({ component: 'agent.antigravity' })

const DEFAULT_BIN = 'agy'
const CONVERSATIONS_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')

/** Returns the path to the imhub MCP sidecar JS file. We reuse the same
 *  sidecar claude-code uses — its protocol surface is messenger-agnostic. */
function sidecarPath(): string {
  // The compiled sidecar lives next to the compiled claude-code adapter:
  //   dist/plugins/agents/claude-code/mcp-approval-server.js
  // From here (dist/plugins/agents/antigravity/index.js) that's:
  //   ../claude-code/mcp-approval-server.js
  return new URL('../claude-code/mcp-approval-server.js', import.meta.url).pathname
}

export class AntigravityAdapter extends AgentBase {
  readonly name = 'antigravity'
  // /agy is the primary alias users will type; /gemini gives the more
  // familiar Google branding label without conflicting with the Gemini CLI
  // (which agim doesn't ship today — if/when we add it, rename this alias).
  readonly aliases = ['agy', 'gemini', 'ag']
  readonly kind = 'cli' as const

  /** Resolved once on first use — survives the process lifetime.
   *  null = "we haven't probed yet"; undefined = "probed and didn't find". */
  private resolvedBin: string | null | undefined = null

  protected get commandName(): string {
    // 1. Explicit override always wins.
    const override = process.env.IMHUB_ANTIGRAVITY_BIN
    if (override) return override

    // 2. Cached lookup result if we already probed.
    if (this.resolvedBin !== null) return this.resolvedBin ?? DEFAULT_BIN

    // 3. Probe common install locations.
    //
    //    The official install.sh drops the binary in `~/.local/bin/agy`
    //    (XDG user-local convention) and edits the user's shell rc to add
    //    that dir to PATH. agim runs under systemd, which doesn't source
    //    user shell rcs, so PATH lookup ('agy') fails on a stock daemon
    //    even when the binary is there. Add the well-known candidates so
    //    operators don't have to hand-set IMHUB_ANTIGRAVITY_BIN just to
    //    get past isAvailable().
    const candidates = [
      join(homedir(), '.local', 'bin', 'agy'),
      '/usr/local/bin/agy',
      '/opt/antigravity/bin/agy',
    ]
    for (const p of candidates) {
      try {
        const s = statSync(p)
        // executable bit check is loose — file existence + mode is enough
        // for our boot-time probe; spawn will surface real EACCES if any.
        if (s.isFile() && (s.mode & 0o111) !== 0) {
          this.resolvedBin = p
          log.info({ event: 'antigravity.bin.resolved', path: p },
            'resolved agy outside PATH')
          return p
        }
      } catch {
        /* not here */
      }
    }

    // 4. Final fallback: bare 'agy' (lets PATH lookup try, and gives a
    //    consistent error path if neither PATH nor candidates have it).
    this.resolvedBin = undefined
    return DEFAULT_BIN
  }

  /** Lazy mcp-config write guard. Without this, every send would touch
   *  the global mcp_config.json. Read-modify-write does a no-op fast-path
   *  when the file is already correct, but we still avoid the disk hit. */
  private mcpReady = false

  /** Last conversation directory mtime we saw before launching a run.
   *  Used to identify the newly-created .pb after a fresh run finishes. */
  private async snapshotConversationMtimes(): Promise<Map<string, number>> {
    const m = new Map<string, number>()
    try {
      const entries = await readdir(CONVERSATIONS_DIR)
      for (const name of entries) {
        if (!name.endsWith('.pb')) continue
        try {
          const s = await stat(join(CONVERSATIONS_DIR, name))
          m.set(name, s.mtimeMs)
        } catch {
          /* gone between readdir and stat — fine */
        }
      }
    } catch {
      /* dir doesn't exist yet — agy creates it on first run */
    }
    return m
  }

  /** Diff snapshots to find the newly-created .pb file. Returns the UUID
   *  portion (.pb stripped) of whichever file is new OR has a newer mtime
   *  than the snapshot, prioritising the freshest one. */
  private async detectNewConversation(before: Map<string, number>): Promise<string | null> {
    try {
      const after = await readdir(CONVERSATIONS_DIR)
      let bestId: string | null = null
      let bestMtime = -Infinity
      for (const name of after) {
        if (!name.endsWith('.pb')) continue
        let mtime: number
        try {
          mtime = (await stat(join(CONVERSATIONS_DIR, name))).mtimeMs
        } catch {
          continue
        }
        const prev = before.get(name)
        if (prev !== undefined && prev >= mtime) continue
        if (mtime > bestMtime) {
          bestMtime = mtime
          bestId = name.replace(/\.pb$/, '')
        }
      }
      return bestId
    } catch {
      return null
    }
  }

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const args: string[] = ['--print']
    if (opts.agentSessionId) {
      args.push('--conversation', opts.agentSessionId)
    }
    args.push(prompt)
    return args
  }

  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    let cwd = resolveAgentCwd(this.name, opts)
    // Defensive cwd existence check. resolveAgentCwd returns a path under
    // ~/.agim-workspaces/<agent>/ that bootstrapAgentWorkspaces creates at
    // agim startup — but if the dir is missing (bootstrap not yet run for
    // a freshly-added agent, operator wiped the tree, etc.) Node's spawn
    // rejects with ENOENT *on the binary path* (misleading: it's actually
    // the cwd that doesn't exist). Lazy-create to avoid that whole class
    // of failures.
    if (cwd) {
      try {
        if (!existsSync(cwd)) await mkdir(cwd, { recursive: true })
      } catch (err) {
        log.warn({ event: 'antigravity.cwd.mkdir_failed', cwd, err: String(err) },
          'falling back to inherited cwd because workspace dir could not be created')
        cwd = undefined
      }
    }
    // Workspace exposure: agy refuses to operate outside its trusted /
    // workspace list (see ~/.gemini/antigravity-cli/settings.json
    // `trustedWorkspaces`). We push the per-agent cwd in explicitly via
    // --add-dir so agy can read/write inside the agim workspace without
    // the operator pre-listing every IM thread's dir.
    const baseArgs: string[] = ['--print']
    if (cwd) {
      baseArgs.unshift('--add-dir', cwd)
    }
    if (opts.agentSessionId) {
      baseArgs.push('--conversation', opts.agentSessionId)
    }

    // MCP wiring. We write the global config the first time we run, then
    // skip the disk hit on subsequent calls (the file is already pointing
    // at the live socket since the same agim process lifetime). On agim
    // restart the cache resets and the next run will rewrite — which is
    // exactly what we need because approval-bus picks a new socket per
    // start.
    const sockPath = approvalBus.getSocketPath()
    if (sockPath && !this.mcpReady) {
      try {
        await ensureImhubMcp({
          command: process.execPath,
          args: [sidecarPath()],
          env: { IMHUB_APPROVAL_SOCK: sockPath },
        })
        this.mcpReady = true
      } catch (err) {
        log.warn({ event: 'antigravity.mcp.disabled', err: String(err) },
          'imhub MCP not wired into agy this run — tool approvals will block on agy default UI')
      }
    }

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
        ...(typeof opts.parentJobId === 'number' ? { parentJobId: opts.parentJobId } : {}),
        ...(typeof opts.callDepth === 'number' ? { callDepth: opts.callDepth } : {}),
      })
      registered = true
      log.info({ event: 'antigravity.approval.routed', runId, threadId, platform },
        'agy run routed via approval-bus')
    }

    baseArgs.push(prompt)

    // Snapshot conversation mtimes BEFORE the spawn so we can detect the
    // newly-created UUID after the run completes.
    const beforeSnapshot = await this.snapshotConversationMtimes()

    // agy is a Go binary that reads $HOME directly to locate
    // ~/.gemini/antigravity-cli/ (creds, conversations, settings). Under
    // systemd, root services often launch with HOME unset (only USER and
    // a stripped PATH are present), and agy then exits 1 with
    // `$HOME is not defined` deep in third_party/jetski/fs/local. Other
    // adapters get away with it because they look up paths via Node's
    // os.homedir() which falls back to /etc/passwd; agy doesn't.
    // homedir() does that fallback for us when env HOME is absent, so we
    // resolve once and pass it through.
    const childHome = process.env.HOME || homedir()

    return {
      args: baseArgs,
      cwd,
      extraEnv: {
        // IMHUB_RUN_ID flows into the imhub MCP sidecar's process env;
        // approval-router uses it to look up the registered run.
        IMHUB_RUN_ID: runId,
        // Force HOME present in the child env (systemd may have stripped it).
        HOME: childHome,
      },
      cleanup: async () => {
        if (registered) approvalBus.unregisterRun(runId)
        // Detect new conversation UUID + call back to cli session-row
        // persistence so the next turn passes `--conversation <uuid>`.
        // Only run when the caller didn't already have a UUID — once it's
        // set, agy reuses it and the file just gets mtime-bumped, so we
        // don't need to re-detect.
        if (!opts.agentSessionId && opts.onAgentSessionId) {
          const id = await this.detectNewConversation(beforeSnapshot)
          if (id) {
            try {
              opts.onAgentSessionId(id)
              log.info({ event: 'antigravity.session.captured', id }, 'captured fresh agy conversation UUID')
            } catch (err) {
              log.debug({ event: 'antigravity.session.callback_failed', err: String(err) })
            }
          }
        }
      },
    }
  }

  /** agy --print emits plain stdout text, not JSONL. The base spawnStream
   *  passes non-JSON lines through verbatim — return '' here so we don't
   *  double-emit when the rare JSON-shaped line slips through. */
  protected extractText(_event: unknown): string {
    return ''
  }

  /** agy reports "Authentication required" when the OAuth token is missing
   *  or expired. Map that to a friendly hint pointing at `agy login`. */
  protected handleError(_code: number, stderr: string, errorMessage: string): string | null {
    const combined = `${stderr} ${errorMessage}`
    if (/Authentication required|authentication timed out|please.*log in/i.test(combined)) {
      return [
        '🔐 Antigravity (agy) 未登录 / 凭据过期。',
        '   在装有 agy 的机器跑：`agy` 然后跟着 OAuth 链接登录。',
        '   首次登录会把 token 写到 ~/.gemini/antigravity-cli/cache/onboarding.json',
      ].join('\n')
    }
    return null
  }

  protected notAvailableMessage(): string {
    return (
      'Antigravity CLI 未安装。安装：\n' +
      '  curl -fsSL https://antigravity.google/cli/install.sh | bash\n' +
      '装完后跑一次 `agy` 走 Google 账号 OAuth 完成首次登录。'
    )
  }

  async isAvailable(): Promise<boolean> {
    // agy doesn't expose --version (only `changelog`); use `agy help`
    // as a cheap availability probe. We don't shell out to `which` to
    // stay cross-platform (Windows lacks it).
    return new Promise((resolve) => {
      const proc = crossSpawn(this.commandName, ['help'], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }
}

export const antigravityAdapter = new AntigravityAdapter()
