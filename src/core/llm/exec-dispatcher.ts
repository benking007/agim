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
import { logger as rootLogger } from '../logger.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'

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
  const timeoutMs = clampTimeout(args.timeout_ms)
  const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : ctx.cwd

  const sandboxMode = (process.env.IMHUB_EXEC_SANDBOX || '').toLowerCase()
  const useSandbox = sandboxMode === 'bwrap' && existsSync('/usr/bin/bwrap')
  const sandboxNetOff = (process.env.IMHUB_EXEC_SANDBOX_NET || '').toLowerCase() === 'off'

  const { bin, argv } = useSandbox
    ? buildBwrapInvocation(command, cwd, sandboxNetOff)
    : { bin: '/bin/sh', argv: ['-c', command] }

  log.info({
    event: 'exec.spawn',
    bin,
    cwd,
    sandbox: useSandbox ? `bwrap${sandboxNetOff ? '+no-net' : ''}` : 'none',
    timeoutMs,
    commandPreview: command.slice(0, 120),
  })

  return await runChild(bin, argv, { cwd, timeoutMs, signal })
}

function buildBwrapInvocation(command: string, cwd: string, netOff: boolean): { bin: string; argv: string[] } {
  const argv: string[] = [
    '--die-with-parent',
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
    '--bind', cwd, cwd,
    '--chdir', cwd,
  ]
  if (netOff) argv.push('--unshare-net')
  argv.push('/bin/sh', '-c', command)
  return { bin: '/usr/bin/bwrap', argv }
}

interface RunOpts { cwd: string; timeoutMs: number; signal: AbortSignal }

function runChild(bin: string, argv: string[], opts: RunOpts): Promise<DispatcherResult> {
  return new Promise<DispatcherResult>((resolve) => {
    const maxOutput = clampNumber(process.env.IMHUB_EXEC_MAX_OUTPUT, DEFAULT_MAX_OUTPUT, 1024, 1024 * 1024)
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false

    const child = spawn(bin, argv, { cwd: opts.cwd, env: process.env, signal: opts.signal })
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
