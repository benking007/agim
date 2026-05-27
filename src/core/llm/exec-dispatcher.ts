// exec-dispatcher — native_exec(cmd) for the native agent (v1.2.62).
//
// Spawns a shell command, captures stdout/stderr, returns JSON. Always
// goes through the policy gate (NOT in default autoAllow), so the user
// sees an IM approval card per command per fingerprint.
//
// Sandbox:
//   IMHUB_EXEC_SANDBOX=bwrap   (Linux only) wraps the command in
//                              bubblewrap with:
//                                --ro-bind /usr /usr
//                                --ro-bind /lib /lib
//                                --ro-bind /lib64 /lib64
//                                --ro-bind /etc/resolv.conf /etc/resolv.conf
//                                --proc /proc
//                                --dev /dev
//                                --bind <cwd> <cwd>     (writable workspace)
//                                --tmpfs /tmp
//                                --unshare-net? — kept ON (allows net so
//                                                 curl/git work)
//                                --die-with-parent
//                              i.e. process sees the host's read-only
//                              userland but cannot touch home dirs /
//                              ~/.agim/ / /root outside cwd. Pure UID
//                              isolation. No net isolation by default
//                              (operators who want it set
//                              IMHUB_EXEC_SANDBOX_NET=off).
//   IMHUB_EXEC_SANDBOX=off | unset → plain spawn, no isolation.
//
// Other env knobs:
//   IMHUB_EXEC_TIMEOUT_MS    default 60_000, hard cap 600_000
//   IMHUB_EXEC_MAX_OUTPUT    default 32_768 bytes per stream

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { logger as rootLogger } from '../logger.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'
import { checkUrlSafety } from './web-dispatcher.js'

const log = rootLogger.child({ component: 'exec-dispatcher' })

const DEFAULT_TIMEOUT_MS = 60_000
const HARD_TIMEOUT_CAP_MS = 600_000
const DEFAULT_MAX_OUTPUT = 32 * 1024

const EXEC_TOOL_NAMES = ['native_exec'] as const
export function isExecToolName(name: string): boolean {
  return (EXEC_TOOL_NAMES as readonly string[]).includes(name)
}

export function getExecTools(): ToolDef[] {
  return [
    {
      name: 'native_exec',
      description:
        'Execute a shell command in the agent\'s workspace. cwd defaults to the agent workspace; ' +
        'optional timeout_ms (default 60000, max 600000). Returns stdout, stderr, exit_code. ' +
        'Each invocation is approval-gated by default — the user sees an IM card with the command ' +
        'and must allow. When IMHUB_EXEC_SANDBOX=bwrap (Linux), runs under bubblewrap so the ' +
        'command can\'t touch home dirs outside cwd.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command. Will be invoked via /bin/sh -c.' },
          timeout_ms: { type: 'number', description: 'Per-call timeout in ms (default 60000, max 600000).' },
          cwd: { type: 'string', description: 'Override cwd. Defaults to the agent workspace.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  ]
}

export interface ExecContext {
  cwd: string
  /** v1.2.97 — when present, every spawned child gets IMHUB_RPC_SOCKET
   *  and IMHUB_RPC_TOKEN env vars so a bgjob-launched Python (or any
   *  language) script can call back into agim's tool surface via the
   *  local RPC server. The token is bound to this exact RunContext so
   *  a worker can only drive its own IM thread. Caller (native/index.ts)
   *  mints a token at turn start; exec-dispatcher injects it on every
   *  spawn under the same turn. Optional — leaving it unset just means
   *  the bgjob child can't call back (the existing v1.2.93 SOP still
   *  works, just without the RPC convenience). */
  rpcCtx?: { platform: string; channelId: string; threadId: string; userId: string }
}

export function buildExecDispatcher(ctx: ExecContext): ToolDispatcher {
  return async (call, signal): Promise<DispatcherResult> => {
    if (!isExecToolName(call.name)) {
      return { text: `not handled: ${call.name}`, isError: true, source: 'unknown' }
    }
    try {
      return await runExec(call.arguments, ctx, signal)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'exec.tool.error', err: msg })
      return { text: `native_exec failed: ${msg}`, isError: true, source: 'exec' }
    }
  }
}

async function runExec(args: Record<string, unknown>, ctx: ExecContext, signal: AbortSignal): Promise<DispatcherResult> {
  const command = typeof args.command === 'string' ? args.command : ''
  if (!command.trim()) return { text: 'command required', isError: true, source: 'exec' }

  // v1.2.66 — pre-flight: dangerous shell pattern denylist. These are
  // hard-blocked regardless of approval card / autoAllow — destructive
  // and unrecoverable. Operators with a legitimate need run them
  // directly on the host, not via the agent.
  const danger = checkDangerousCommand(command)
  if (danger) {
    log.warn({ event: 'exec.refused.dangerous_pattern', reason: danger, commandPreview: command.slice(0, 120) })
    return {
      text: `native_exec refused: command matches a dangerous-pattern denylist (${danger}). If you legitimately need to run this, do it directly on the host — not via the agent. To override, the operator must edit src/core/llm/exec-dispatcher.ts:DANGEROUS_PATTERNS.`,
      isError: true,
      source: 'exec',
    }
  }

  // v1.2.66 — defense-in-depth: scan the command for embedded internal
  // URLs (e.g. `curl http://169.254.169.254/...`, `wget http://10.0.0.1/`).
  // Without this, a model that's been instructed "don't fetch internal
  // hosts" can bypass the web-tool SSRF block by piping through exec.
  // Honours IMHUB_NATIVE_WEB_SSRF_WHITELIST (shared with web tools).
  const internalUrlReason = scanCommandForInternalUrl(command)
  if (internalUrlReason) {
    log.warn({ event: 'exec.refused.internal_url', reason: internalUrlReason, commandPreview: command.slice(0, 120) })
    return {
      text: `native_exec refused: command contains a URL targeting a private/internal address (${internalUrlReason}). ` +
        `If this is intentional, set IMHUB_NATIVE_WEB_SSRF_WHITELIST or IMHUB_NATIVE_WEB_ALLOW_PRIVATE=1.`,
      isError: true,
      source: 'exec',
    }
  }

  const timeoutMs = clampTimeout(args.timeout_ms)
  const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : ctx.cwd

  const sandboxMode = (process.env.IMHUB_EXEC_SANDBOX || '').toLowerCase()
  const sandboxConfigured = sandboxMode === 'bwrap' && existsSync('/usr/bin/bwrap')
  const sandboxNetOff = (process.env.IMHUB_EXEC_SANDBOX_NET || '').toLowerCase() === 'off'

  // v1.2.93 — sandbox carve-out for the bgjob long-task wrapper. bgjob
  // detaches its worker via setsid (Python `start_new_session=True`);
  // bwrap's pid/cgroup namespace tears down the whole tree the moment
  // exec returns, so `bgjob start` looks like it succeeded but the
  // worker dies a second later. We bypass the sandbox only when the
  // command is unambiguously invoking one of the known bgjob wrapper
  // paths. Plain `bgjob` (PATH lookup) is NOT carved out because we
  // can't distinguish an attacker-controlled shim of the same name.
  const isBgjob = sandboxConfigured && isBgjobInvocation(command)
  const useSandbox = sandboxConfigured && !isBgjob

  const { bin, argv } = useSandbox
    ? buildBwrapInvocation(command, cwd, sandboxNetOff)
    : { bin: '/bin/sh', argv: ['-c', command] }

  // v1.2.97 — mint a per-spawn RPC token + injection env. Bound to
  // the current IM thread so the child can ONLY drive that thread's
  // memo / push / skill surface, never anyone else's. Best-effort:
  // if minting fails (RPC server didn't start, no rpcCtx) the spawn
  // still runs — Python sidecar inside the child will just refuse
  // to construct a client (raises RuntimeError on missing env).
  let extraEnv: NodeJS.ProcessEnv | undefined
  if (ctx.rpcCtx) {
    try {
      const { mintRpcToken, resolveSocketPath } = await import('./agim-rpc-server.js')
      const { token } = mintRpcToken(ctx.rpcCtx, 'native_exec')
      extraEnv = { IMHUB_RPC_SOCKET: resolveSocketPath(), IMHUB_RPC_TOKEN: token }
    } catch (err) {
      log.debug({
        event: 'exec.rpc_mint_failed',
        err: err instanceof Error ? err.message : String(err),
      }, 'failed to mint RPC token; child will boot without IMHUB_RPC_*')
    }
  }

  log.info({
    event: 'exec.spawn',
    bin,
    cwd,
    sandbox: useSandbox ? `bwrap${sandboxNetOff ? '+no-net' : ''}` : (isBgjob ? 'bypassed-for-bgjob' : 'none'),
    rpcTokenInjected: !!extraEnv,
    timeoutMs,
    commandPreview: command.slice(0, 120),
  })

  return await runChild(bin, argv, { cwd, timeoutMs, signal, extraEnv })
}

// v1.2.66 — danger pattern matching. Patterns intentionally err on the
// false-positive side: refusing a legitimate `rm -rf ./build` is a
// minor annoyance, but missing a `rm -rf /` is unrecoverable. Each
// pattern returns a human-readable reason so the model + user can
// understand the block.
interface DangerPattern { regex: RegExp; reason: string }
const DANGEROUS_PATTERNS: DangerPattern[] = [
  // rm -rf with paths that touch root / home root / ~. Allow narrow
  // forms like `rm -rf ./build` and `rm -rf subdir/`.
  { regex: /(?:^|[;&|`(])\s*rm\s+(?:-[a-zA-Z]*[rfRF][a-zA-Z]*\s+)+(?:\/(?:\s|$|\*)|~\/?(?:\s|$)|\.\.\/+|\/\*)/, reason: 'rm -rf against root / home / .. — destructive' },
  // Filesystem formatting / partition tools.
  { regex: /\b(mkfs(?:\.\w+)?|mke2fs|mkdosfs|mkntfs|wipefs|fdisk|parted|sfdisk|cfdisk|gdisk)\b/, reason: 'filesystem format / partition tool' },
  // Raw block-device writes.
  { regex: /\bdd\s+[^|;]*\bof=\/dev\/(sd[a-z][0-9]*|nvme[0-9]+n[0-9]+(p[0-9]+)?|mmcblk[0-9]+|vd[a-z][0-9]*|hd[a-z][0-9]*|loop[0-9]+)/, reason: 'dd to raw block device' },
  // Classic fork bomb (and minor variants).
  { regex: /:\s*\(\s*\)\s*\{[^}]*\|\s*:\s*&?\s*\}\s*;\s*:/, reason: 'fork bomb' },
  // Recursive chmod 777 / chown - root.
  { regex: /\b(chmod|chown)\s+-R\s+[^\s]*\s+\/(?:\s|$)/, reason: 'recursive chmod/chown on /' },
  // Permanent kernel writes.
  { regex: /\becho\s+.*>\s*\/proc\/sys\/kernel\/(panic|sysrq)/, reason: 'writing to /proc/sys/kernel/panic|sysrq' },
  // shutdown / reboot / halt commands.
  { regex: /\b(shutdown|reboot|halt|poweroff)\b(?!\s+--?(help|version))/, reason: 'shutdown / reboot / halt' },
  // Disable swap on /. (Rare; precaution.)
  { regex: /\bswapoff\s+-a\b/, reason: 'swapoff -a' },
  // Make a setuid root binary.
  { regex: /\bchmod\s+(?:[ug]\+s|4[0-7]{3})\b/, reason: 'setuid / setgid bit change' },
  // > /etc/passwd or > /etc/shadow.
  { regex: />\s*\/etc\/(passwd|shadow|sudoers)\b/, reason: 'writing to /etc/passwd|shadow|sudoers' },
]

function checkDangerousCommand(cmd: string): string | null {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.regex.test(cmd)) return p.reason
  }
  return null
}

/**
 * v1.2.93 / v1.2.99 — detect "this command is invoking the agim
 * long-task bgjob wrapper". When it is, the caller skips bwrap so the
 * wrapper's setsid-detached worker actually survives past exec return.
 *
 * Security model (tightened in v1.2.99 after CR finding A1):
 *   - We bypass bwrap for the **entire** shell command line. So a
 *     command like `bgjob status x && cat /etc/shadow > /tmp/leak`
 *     would let `cat` run on the host FS, totally outside sandbox.
 *   - To prevent that, this matcher now **only** returns true when
 *     the trimmed command IS a single bgjob invocation: it must start
 *     with one of the absolute wrapper paths, AND contain NO shell
 *     metacharacters that could chain extra commands (`;` `&` `|`
 *     `(` `)` `<` `>` `` ` `` `$`). Anything else falls through to
 *     sandbox.
 *   - Bare `bgjob` (PATH lookup) is still refused: an attacker-
 *     controlled shim of the same name in PATH must not inherit the
 *     bypass.
 *
 * Matched paths (absolute only):
 *   - /root/.claude/scripts/bgjob       (Claude Code wrapper)
 *   - /root/.config/opencode/scripts/bgjob  (opencode wrapper; same script)
 */
const BGJOB_PATHS = [
  '/root/.claude/scripts/bgjob',
  '/root/.config/opencode/scripts/bgjob',
]

/** Shell metacharacters that could chain additional commands. We
 *  reject the whole bypass if any are present in the command, even
 *  when the bgjob wrapper itself sits at the start. */
const SHELL_CHAIN_META = /[;&|()<>`$]/

export function isBgjobInvocation(cmd: string): boolean {
  const trimmed = cmd.trim()
  // v1.2.99 — refuse if the command contains anything that could
  // tack on extra payload. Includes subshell `( ... )`, backticks,
  // `$( ... )` substitution, redirection, and obvious chaining.
  if (SHELL_CHAIN_META.test(trimmed)) return false
  for (const path of BGJOB_PATHS) {
    // Path must be at the START of the (trimmed) command, followed
    // by whitespace or EOL. No leading args / env-var assignments /
    // sudo are allowed before the bgjob path.
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${escaped}(?:\\s|$)`)
    if (re.test(trimmed)) return true
  }
  return false
}

function scanCommandForInternalUrl(cmd: string): string | null {
  // Pull plausible URL tokens out of the command and feed each through
  // the web-dispatcher's checkUrlSafety. Stops at first private hit.
  const urlRe = /https?:\/\/[^\s"'`;|<>]+/gi
  for (const match of cmd.matchAll(urlRe)) {
    const url = match[0]
    const safe = checkUrlSafety(url)
    if (!safe.ok) return `${url} — ${safe.reason ?? 'private'}`
  }
  return null
}

function buildBwrapInvocation(command: string, cwd: string, netOff: boolean): { bin: string; argv: string[] } {
  // v1.2.66 — tmpfs-mask the agim state dir + the cwd's parent before
  // binding cwd back. Without this, even though sensitive-paths.ts
  // blocks tool-arg paths to ~/.agim/, an exec'd shell command can
  // still `cat ~/.agim/env` because the FS is exposed transparently.
  // Mirrors nanobot's `--tmpfs <ws.parent>` pattern, adapted for
  // agim's path layout (`~/.agim` is a sibling of
  // `~/.agim-workspaces`, not a parent).
  const home = homedir()
  const cwdParent = dirname(cwd)
  const argv: string[] = [
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind-try', '/etc/ssl', '/etc/ssl',
    '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    // Mask the agim per-user state dir (~/.agim/) — primary target.
    // ~/.im-hub legacy path covered for older installs.
    '--tmpfs', `${home}/.agim`,
    '--tmpfs', `${home}/.im-hub`,
    // Mask the parent of the workspace cwd so the agent can't list
    // sibling threads' workspaces. cwdParent is typically
    // ~/.agim-workspaces/native/, and other threads live there.
    '--tmpfs', cwdParent,
    // Re-mount the actual cwd over the masked parent so the agent
    // still has its workspace. `--dir` recreates the path inside the
    // sandbox; `--bind` brings the host content back.
    '--dir', cwd,
    '--bind', cwd, cwd,
    '--chdir', cwd,
  ]
  if (netOff) argv.push('--unshare-net')
  argv.push('--', '/bin/sh', '-c', command)
  return { bin: '/usr/bin/bwrap', argv }
}

interface RunOpts { cwd: string; timeoutMs: number; signal: AbortSignal; extraEnv?: NodeJS.ProcessEnv }

function runChild(bin: string, argv: string[], opts: RunOpts): Promise<DispatcherResult> {
  return new Promise<DispatcherResult>((resolve) => {
    const maxOutput = clampNumber(process.env.IMHUB_EXEC_MAX_OUTPUT, DEFAULT_MAX_OUTPUT, 1024, 1024 * 1024)
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false

    const env = opts.extraEnv ? { ...process.env, ...opts.extraEnv } : process.env
    const child = spawn(bin, argv, { cwd: opts.cwd, env, signal: opts.signal })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      // Hard SIGKILL after a 3s grace period so the dispatcher doesn't
      // hang on a process that ignores SIGTERM.
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 3_000).unref()
    }, opts.timeoutMs)
    timer.unref()

    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length >= maxOutput) { stdoutTruncated = true; return }
      const room = maxOutput - stdout.length
      stdout += chunk.length > room ? chunk.slice(0, room) : chunk
      if (chunk.length > room) stdoutTruncated = true
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length >= maxOutput) { stderrTruncated = true; return }
      const room = maxOutput - stderr.length
      stderr += chunk.length > room ? chunk.slice(0, room) : chunk
      if (chunk.length > room) stderrTruncated = true
    })
    child.on('close', (code, signalName) => {
      clearTimeout(timer)
      const exitCode = code ?? -1
      const payload = {
        exit_code: exitCode,
        signal: signalName ?? null,
        timed_out: timedOut,
        stdout,
        stderr,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
      }
      // Treat non-zero as error so the model sees `isError: true` and
      // can react (e.g. retry with different args). Timed-out gets a
      // dedicated message at the top.
      const isError = timedOut || (exitCode !== 0 && exitCode !== null)
      const summary = timedOut
        ? `command timed out after ${opts.timeoutMs}ms; partial output below.\n`
        : ''
      resolve({
        text: summary + JSON.stringify(payload, null, 2),
        isError,
        source: 'exec',
      })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        text: `spawn failed: ${err.message}`,
        isError: true,
        source: 'exec',
      })
    })
  })
}

function clampTimeout(raw: unknown): number {
  const fromArg = typeof raw === 'number' ? raw : Number(raw)
  if (Number.isFinite(fromArg) && fromArg > 0) {
    return Math.min(HARD_TIMEOUT_CAP_MS, Math.floor(fromArg))
  }
  const env = process.env.IMHUB_EXEC_TIMEOUT_MS
  if (env) {
    const n = Number(env)
    if (Number.isFinite(n) && n > 0) return Math.min(HARD_TIMEOUT_CAP_MS, Math.floor(n))
  }
  return DEFAULT_TIMEOUT_MS
}

function clampNumber(input: unknown, dflt: number, min: number, max: number): number {
  const n = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.floor(n)))
}
