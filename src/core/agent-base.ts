// AgentBase — base class for CLI-based agent adapters
//
// Provides a unified streaming JSONL invocation pipeline:
//   sendPrompt        — true AsyncGenerator that yields chunks live
//   spawnAndCollect   — Promise<string> wrapper for job-board / sync calls
//   isAvailable       — `--version` probe
//   buildContextualPrompt / buildArgs / extractText — subclass hooks
//
// Subclasses must implement: buildArgs(), extractText().
// Optional override: handleError(), emptyOutputMessage(), notAvailableMessage(), commandName.

import { StringDecoder } from 'node:string_decoder'
import type { AgentAdapter, AgentSendOpts, ChatMessage } from './types.js'
import { crossSpawn } from '../utils/cross-platform.js'
import { logger as rootLogger } from './logger.js'

const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Idle (no-stdout) timeout for the agent child process.
 *
 * Previously a 30-min hard total-time cap that killed agents mid-conversation
 * when a human took a long time to approve a tool call — "waiting on the
 * user" is not "agent is dead", but the old setTimeout couldn't tell them
 * apart. Switched to idle semantics: the watchdog arms a timer that resets
 * on every stdout/stderr chunk, so slow human round-trips through the IM
 * approval flow no longer count against the budget; only true silence
 * (no events at all for `idleTimeout` ms) counts as hang.
 *
 * Priority: `${NAME}_IDLE_TIMEOUT_MS` > `AGIM_AGENT_IDLE_TIMEOUT_MS` > default.
 * Setting any of these to `0` disables the watchdog entirely (relies on the
 * agent's internal timeouts plus manual termination).
 */
function resolveIdleTimeout(perAgentEnvKey: string): number {
  const sources: Array<[string, string | undefined]> = [
    [perAgentEnvKey, process.env[perAgentEnvKey]],
    ['AGIM_AGENT_IDLE_TIMEOUT_MS', process.env.AGIM_AGENT_IDLE_TIMEOUT_MS],
  ]
  for (const [envKey, raw] of sources) {
    if (raw === undefined) continue
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) return n
    rootLogger.warn({ event: 'agent.idle-timeout.invalid', raw, envKey },
      `Invalid idle timeout env "${envKey}=${raw}", trying next source / default`)
  }
  return DEFAULT_IDLE_TIMEOUT_MS
}

/**
 * Buffer line splitter that respects UTF-8 multi-byte boundaries.
 *
 * Holds a single `partial` string of bytes seen so far without a newline
 * boundary. push(chunk) returns any complete lines found in
 * partial+chunk, and resets partial to the remainder.
 *
 * Implementation notes:
 *   - Uses StringDecoder so a 3-byte CJK codepoint split across chunks
 *     stays whole (no U+FFFD).
 *   - Skips the partial+chunk concat when the chunk has no newline AND
 *     partial is empty (the common case for tiny chunks).
 *   - Walks via indexOf + slice instead of String.split so we avoid
 *     allocating an intermediate array of every line just to pop the
 *     last one back into partial.
 */
class LineBuffer {
  private decoder = new StringDecoder('utf8')
  private partial = ''

  push(chunk: Buffer): string[] {
    const decoded = this.decoder.write(chunk)
    if (!decoded) return []

    if (decoded.indexOf('\n') === -1) {
      // No newline in this chunk — extend partial. V8 ropes strings, so
      // the concat is amortized O(1) here.
      this.partial += decoded
      return []
    }

    const data = this.partial.length === 0 ? decoded : this.partial + decoded
    const out: string[] = []
    let start = 0
    while (true) {
      const nl = data.indexOf('\n', start)
      if (nl === -1) break
      out.push(data.slice(start, nl))
      start = nl + 1
    }
    this.partial = start < data.length ? data.slice(start) : ''
    return out
  }

  flush(): string[] {
    const tail = this.decoder.end()
    const data = this.partial.length === 0 ? tail : this.partial + tail
    this.partial = ''
    if (data.length === 0) return []

    const out: string[] = []
    let start = 0
    while (true) {
      const nl = data.indexOf('\n', start)
      if (nl === -1) break
      if (nl > start) out.push(data.slice(start, nl))
      start = nl + 1
    }
    if (start < data.length) out.push(data.slice(start))
    return out
  }
}

/** Internal record of a single streaming agent run. */
export interface SpawnEvent {
  /** Text chunk to surface to the caller. */
  text: string
}

/**
 * Self-contained description of a single CLI invocation. Returned by
 * prepareCommand() and consumed by spawnStream(). All per-call state lives
 * here — never on the adapter instance — so concurrent sendPrompt() calls
 * (which is the norm: one IM thread per chat) cannot clobber each other.
 */
export interface SpawnPlan {
  args: string[]
  /** Extra env merged onto process.env for this spawn. */
  extraEnv?: Record<string, string>
  /**
   * Working directory for the spawned CLI. Adapters use this to give each
   * agent (claude-code, opencode) its own isolated cwd in the IM context, so
   * Claude's per-cwd memory / project history and opencode's AGENTS.md don't
   * collide with the user's terminal sessions. Falls through to inherit
   * agim's own cwd ("/" under systemd) when undefined.
   */
  cwd?: string
  /** Always called once after the CLI exits, even on error/timeout/abort. */
  cleanup?: () => void | Promise<void>
}

export abstract class AgentBase implements AgentAdapter {
  abstract readonly name: string
  abstract readonly aliases: string[]

  /** Binary name to check for isAvailable */
  protected get commandName(): string { return this.name }

  /**
   * Build CLI args. Pass the per-call opts so model/variant/etc. flow through
   * without needing instance state. Subclasses doing only synchronous arg
   * construction can stay here; for async setup (temp files, registry
   * writes) override prepareCommand() instead.
   */
  protected abstract buildArgs(prompt: string, opts: AgentSendOpts): string[]

  /**
   * Returns a complete spawn plan. Default implementation just wraps
   * buildArgs(). Subclasses needing per-call temp resources (mcp-config
   * file, registered run id, etc.) should override and put ALL derived
   * state inside the returned plan / closure — never on `this`, since
   * concurrent spawns would race.
   */
  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    return { args: this.buildArgs(prompt, opts) }
  }

  /** Extract text content from a JSONL event object. */
  protected abstract extractText(event: unknown): string

  /**
   * Optional side-channel hook fired for every parsed JSONL event before
   * extractText. Default no-op. Used by adapters whose CLI surfaces metadata
   * (session id, cost, token counts) inline with content events — they
   * dispatch back to the caller via `opts.onAgentSessionId` / `opts.onUsage`.
   *
   * Keep it cheap: this runs on the hot stdout path. No network or disk.
   */
  protected inspectEvent(_event: unknown, _opts: AgentSendOpts): void { /* default no-op */ }

  /** Optional: transform error info into a user-friendly message string (resolved instead of rejected). */
  protected handleError(_code: number, _stderr: string, _errorMessage: string): string | null {
    return null // default: reject
  }

  /** Optional: return user-friendly unavailable message. */
  protected notAvailableMessage(): string {
    return `${this.name} CLI not found. Please install it.`
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = crossSpawn(this.commandName, ['--version'], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }

  /** Lightweight health probe (same as isAvailable for CLI agents). */
  async healthCheck(): Promise<{ ok: boolean; latencyMs?: number }> {
    const start = Date.now()
    const ok = await this.isAvailable()
    return { ok, latencyMs: Date.now() - start }
  }

  /**
   * Stream JSONL chunks live. Yields each `extractText` result as it
   * arrives; on non-zero exit, yields the friendly error tail (if any) and
   * returns.
   */
  async *sendPrompt(_sessionId: string, prompt: string, history?: ChatMessage[], opts?: AgentSendOpts): AsyncGenerator<string> {
    rootLogger.info({ component: `agent.${this.name}`, agent: this.name, historyLen: history?.length || 0 },
      `[${this.name}] sendPrompt`)
    const contextualPrompt = this.buildContextualPrompt(prompt, history)
    // v1.1.10: forward opts.signal so callers (A2A) can abort hanging child
    // processes on timeout. agent-specific adapters that override sendPrompt
    // should do the same.
    yield* this.spawnStream(contextualPrompt, opts?.signal, opts || {})
  }

  /**
   * Build prompt with conversation history context.
   * Subclasses may override for custom formatting.
   */
  protected buildContextualPrompt(prompt: string, history?: ChatMessage[]): string {
    if (!history || history.length === 0) {
      return prompt
    }
    const historyText = history
      .map(msg => `[${msg.role === 'user' ? 'User' : 'Assistant'}]: ${msg.content}`)
      .join('\n\n')
    return `Previous conversation context:\n${historyText}\n\nCurrent request: ${prompt}`
  }

  /** Idle (no-stdout) timeout for the agent child process in ms. Override per
   *  agent via `${NAME}_IDLE_TIMEOUT_MS`, globally via `AGIM_AGENT_IDLE_TIMEOUT_MS`,
   *  or set 0 to disable. Default 60 min — long enough to ride out an hour-long
   *  human-in-the-loop pause, short enough to reap a truly hung child. */
  protected get idleTimeoutMs(): number {
    return resolveIdleTimeout(`${this.name.toUpperCase()}_IDLE_TIMEOUT_MS`)
  }

  /**
   * Sync convenience wrapper: drain the streaming generator into a single
   * string. Used by Job Board where the caller wants the final result.
   */
  public async spawnAndCollect(prompt: string, signal?: AbortSignal, opts: AgentSendOpts = {}): Promise<string> {
    let acc = ''
    for await (const chunk of this.spawnStream(prompt, signal, opts)) {
      acc += chunk
    }
    return acc
  }

  /**
   * Core streaming pipeline: spawn the CLI, parse JSONL line-by-line, yield
   * each extracted text fragment. Handles timeout, abort, and process exit
   * with cleanup of all timers and listeners.
   */
  protected async *spawnStream(prompt: string, signal?: AbortSignal, opts: AgentSendOpts = {}): AsyncGenerator<string> {
    const idleTimeout = this.idleTimeoutMs
    let outcomeReported = false
    const reportOutcome = (outcome: Parameters<NonNullable<AgentSendOpts['onOutcome']>>[0]) => {
      if (outcomeReported) return
      outcomeReported = true
      try { opts.onOutcome?.(outcome) } catch { /* observer isolation */ }
    }

    // prepareCommand returns a self-contained plan — args, optional extra env,
    // optional cleanup. No instance state involved, so concurrent spawnStream
    // calls cannot race each other. (Previously setupSpawn() would mutate
    // this.mcpConfigPath etc. between awaits, leading to two parallel claude
    // runs sharing one mcp.json and the second one finding it already deleted.)
    let plan: SpawnPlan
      plan = await this.prepareCommand(prompt, opts)

    const proc = crossSpawn(this.commandName, plan.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: plan.extraEnv ? { ...process.env, ...plan.extraEnv } : undefined,
      cwd: plan.cwd,
    })

    const buf = new LineBuffer()
    const stderrBuf = new LineBuffer()
    let stderrAccum = ''
    let errorMessage = ''
    let pendingChunks: string[] = []
    let closed = false
    let exitCode: number | null = null
    let spawnError: Error | null = null
    let timedOut = false
    let aborted = false
    let yieldedText = false

    // Each `notify` resolves the current poll cycle; the consumer awaits a
    // promise that flips whenever new state is available.
    let notify: (() => void) | null = null
    const wait = (): Promise<void> => new Promise((resolve) => { notify = resolve })
    const ping = (): void => { const n = notify; notify = null; n?.() }

    // Idle watchdog: re-armed every time stdout or stderr emits a chunk.
    // Only fires when the child has been completely silent for `idleTimeout`
    // ms — slow human approvals routed through the IM don't count, because
    // when the approval finally returns the agent resumes and the next
    // stdout chunk resets the timer. Pass idleTimeout=0 to disable.
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleKill = (): void => {
      if (killTimer) return
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
      }, 5000)
    }

    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const armIdleTimer = (): void => {
      if (idleTimeout <= 0) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        // Escalate to SIGKILL after 5s if the child ignores SIGTERM — matches
        // the abort path. Without this, a process that's wedged in a signal-
        // ignoring state (uninterruptible syscall, signal mask, ...) would
        // never die and the spawnStream consumer would hang waiting for the
        // close event that never comes.
        scheduleKill()
        ping()
      }, idleTimeout)
    }
    armIdleTimer()

    const onAbort = (): void => {
      aborted = true
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      scheduleKill()
      ping()
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    proc.stdout?.on('data', (data: Buffer) => {
      armIdleTimer()
      const lines = buf.push(data)
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event && typeof event === 'object') {
            const e = event as Record<string, unknown>
            if (typeof e.error === 'string') errorMessage = e.error
          }
          if (event && typeof event === 'object' && (event as Record<string, unknown>).type === 'error') {
            const e = event as Record<string, unknown>
            errorMessage = (e.error as string) || (e.message as string) || 'error event'
            // Don't yield error event content alongside extractText
            continue
          }
          this.inspectEvent(event, opts)
          const text = this.extractText(event)
          if (text) pendingChunks.push(text)
        } catch {
          // Non-JSON line — pass through verbatim with newline preserved
          pendingChunks.push(`${line}\n`)
        }
      }
      if (pendingChunks.length > 0) ping()
    })

    proc.stderr?.on('data', (data: Buffer) => {
      armIdleTimer()
      stderrAccum += data.toString()
      // Surface to root logger as warn — pino-aware, no console.error noise
      for (const line of stderrBuf.push(data)) {
        if (line.trim()) {
          rootLogger.warn({ component: `agent.${this.name}`, agent: this.name, stderr: line }, `[${this.name}] stderr`)
        }
      }
    })

    proc.on('error', (err) => {
      spawnError = err
      closed = true
      ping()
    })

    // 'exit' fires the moment the kernel reaps the child; 'close' waits for
    // ALL inherited stdio file descriptors to also close. Some agents
    // (notably Antigravity / agy) leak stdout/stderr into MCP sidecar
    // sub-processes — when the agent itself exits, those sidecars get
    // re-parented to init (PPID=1) and keep the pipe open, so Node never
    // emits 'close' on the parent ChildProcess. Without this, the
    // spawnStream consumer hangs forever on its `await wait()` despite
    // the agent being long gone.
    //
    // Workaround: on 'exit', destroy our end of stdout/stderr ourselves.
    // The streams' own 'close' then fires (since the reader side ended),
    // which lets the ChildProcess emit its 'close' event normally and the
    // existing handler below does its usual cleanup. This is idempotent —
    // if agents don't have the leak, destroy() is a no-op against an
    // already-closed stream.
    proc.on('exit', () => {
      try { proc.stdout?.destroy() } catch { /* already closed */ }
      try { proc.stderr?.destroy() } catch { /* already closed */ }
    })

    proc.on('close', (code) => {
      exitCode = code
      closed = true
      // Flush any remaining stderr line
      for (const line of stderrBuf.flush()) {
        if (line.trim()) {
          rootLogger.warn({ component: `agent.${this.name}`, agent: this.name, stderr: line }, `[${this.name}] stderr`)
        }
      }
      // Flush any non-newline-terminated tail in stdout buffer
      for (const line of buf.flush()) {
        try {
          const event = JSON.parse(line)
          const text = this.extractText(event)
          if (text) pendingChunks.push(text)
        } catch {
          pendingChunks.push(line)
        }
      }
      ping()
    })

    try {
      while (!closed || pendingChunks.length > 0) {
        if (pendingChunks.length === 0) {
          await wait()
          if (aborted) break
          if (timedOut) break
        }
        // Drain whatever has accumulated this cycle
        const out = pendingChunks
        pendingChunks = []
        for (const c of out) {
          yieldedText = true
          yield c
        }
      }

      if (timedOut) {
        const mins = Math.round(idleTimeout / 60000)
        rootLogger.warn(
          { component: `agent.${this.name}`, agent: this.name, idleTimeoutMs: idleTimeout, reason: 'idle' },
          `[${this.name}] killed after ${mins}min of no stdout/stderr (likely hang)`)
        reportOutcome({ status: 'timeout', providerFailure: true, error: `idle timeout ${idleTimeout}ms` })
        yield `\n\n⚠️ agent 子进程 ${mins} 分钟无任何输出，强制超时（可能 hang 或网络挂起）`
        return
      }

      if (aborted) {
        rootLogger.info({ component: `agent.${this.name}`, agent: this.name }, `[${this.name}] cancelled via signal`)
        reportOutcome({ status: 'aborted', providerFailure: false })
        yield '\n\n🚫 任务已被取消。'
        return
      }

      if (spawnError) {
        // Assigned from proc 'error' callback — CF analysis may treat the
        // outer binding as always-null; re-bind through a typed local.
        const err = spawnError as NodeJS.ErrnoException
        const detail = err.message || String(err)
        // Kernel ARG_MAX overflow — common when CLI adapters put a huge
        // Loop/Focus/history prompt into spawn argv (Codex/Claude Code).
        if (err.code === 'E2BIG' || /E2BIG/i.test(detail)) {
          reportOutcome({ status: 'error', providerFailure: true, error: detail })
          yield [
            `⚠️ \`${this.name}\` 启动失败：命令行参数过长（spawn E2BIG）。`,
            '',
            '常见原因：历史 / Focus / Loop 上下文被塞进 CLI 参数。',
            '若正在跑 **/loop**：请把 Portal Agent 切回 **Agim**（Loop 父编排），',
            'Codex 等仍可通过 `call_agents` 作为子代理。',
          ].join('\n')
          return
        }
        throw err
      }

      rootLogger.info({
        component: `agent.${this.name}`,
        agent: this.name,
        exitCode,
      }, `[${this.name}] process closed`)

      if (exitCode !== null && exitCode !== 0) {
        const friendly = this.handleError(exitCode, stderrAccum, errorMessage)
        reportOutcome({
          status: 'error',
          providerFailure: true,
          error: errorMessage || stderrAccum.trim() || `exit ${exitCode}`,
        })
        if (friendly !== null) {
          yield friendly
          return
        }
        let detail = ''
        if (errorMessage) detail = errorMessage
        if (!detail && stderrAccum.trim() && stderrAccum.trim().length < 200) {
          detail = stderrAccum.trim()
        }
        yield `${this.name} failed (exit ${exitCode})${detail ? `: ${detail}` : ''}`
      } else if (!yieldedText) {
        const empty = this.emptyOutputMessage(stderrAccum, errorMessage)
        if (empty !== null) yield empty
      }
      reportOutcome({ status: 'success', providerFailure: false })
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      if (killTimer) clearTimeout(killTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (plan.cleanup) {
        try { await plan.cleanup() } catch (err) {
          // L13: surface to /api/metrics in addition to pino so ops can
          // alert on cumulative cleanup failures (orphan tmpdir leakage).
          const { recordAgentCleanupFailure } = await import('./metrics.js')
          recordAgentCleanupFailure()
          rootLogger.warn({ component: `agent.${this.name}`, agent: this.name, err: String(err) },
            `[${this.name}] cleanup hook threw`)
        }
      }
    }
  }

  protected emptyOutputMessage(_stderr: string, _errorMessage: string): string | null {
    return null
  }
}
