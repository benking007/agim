// Shared spawn helper for coding-domain dispatchers (git / diagnostics / gate).

import { spawn } from 'node:child_process'

export interface RunCmdResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export function runCmd(
  bin: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<RunCmdResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      signal: opts.signal,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (c: string) => { stdout += c })
    child.stderr?.on('data', (c: string) => { stderr += c })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, stdout, stderr: err.message, timedOut })
    })
  })
}

export function clampMs(input: unknown, dflt: number, min: number, max: number): number {
  const n = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.floor(n)))
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`
}
