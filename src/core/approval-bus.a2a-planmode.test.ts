// SEC regression — plan-mode propagation across the approval-bus A2A path.
//
// When a run executes under plan-mode (user did /plan on, parent agent is
// read-only) and that run fires mcp__imhub__call_agent, bus.handleA2A must
// forward planMode to callAgentByName so the callee also launches read-only.
// Without it a plan-mode parent could delegate a write task to another agent
// that starts with full write access — bypassing the user's intent.
//
// We mock ./a2a.js (handleA2A lazy-imports { callAgentByName } from it) to
// capture the opts it receives, then drive the bus over a real unix socket
// exactly like a sidecar would.

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { type Socket, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// Captures the opts of the most recent callAgentByName invocation.
let lastCallOpts: Record<string, unknown> | null = null
mock.module('./a2a.js', () => ({
  callAgentByName: async (
    agent: string, _prompt: string, _ctx: unknown, opts: Record<string, unknown>,
  ) => {
    lastCallOpts = opts
    return { ok: true, result: 'stub', jobId: 1, agent, durationMs: 1 }
  },
}))

// Import AFTER the mock is registered. (approval-bus only *dynamically*
// imports a2a, so static ordering is not load-bearing — kept for clarity.)
const { ApprovalBus } = await import('./approval-bus.js')
type RunContext = import('./approval-bus.js').RunContext

function uniqueSocketPath(): string {
  return join(tmpdir(), `imhub-planmode-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

/** Minimal NDJSON client over the unix socket — resolves the next message. */
class MiniClient {
  private buf = ''
  private queue: unknown[] = []
  private waiters: Array<(v: unknown) => void> = []
  constructor(private socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buf += chunk
      for (let nl = this.buf.indexOf('\n'); nl !== -1; nl = this.buf.indexOf('\n')) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        const obj = JSON.parse(line)
        const w = this.waiters.shift()
        if (w) w(obj); else this.queue.push(obj)
      }
    })
  }
  send(obj: unknown): void { this.socket.write(`${JSON.stringify(obj)}\n`) }
  next(timeoutMs = 1000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const queued = this.queue.shift()
      if (queued !== undefined) { resolve(queued as Record<string, unknown>); return }
      const timer = setTimeout(() => reject(new Error('next() timed out')), timeoutMs)
      this.waiters.push((v) => { clearTimeout(timer); resolve(v as Record<string, unknown>) })
    })
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) { resolve(); return }
      this.socket.once('close', () => resolve())
      this.socket.end()
    })
  }
}

function connect(path: string): Promise<MiniClient> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path)
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.removeAllListeners('error')
      sock.on('error', () => { /* swallow post-connect errors in tests */ })
      resolve(new MiniClient(sock))
    })
  })
}

describe('approval-bus A2A plan-mode propagation', () => {
  let bus: InstanceType<typeof ApprovalBus>
  let path: string

  beforeEach(async () => {
    lastCallOpts = null
    bus = new ApprovalBus({ approvalTimeoutMs: 200 })
    path = uniqueSocketPath()
    await bus.start(path)
  })
  afterEach(async () => { await bus.stop() })

  it('forwards planMode=true to the callee when the run is in plan-mode', async () => {
    const ctx: RunContext = {
      threadId: 't', platform: 'feishu', userId: 'u', channelId: 'c',
      callerAgent: 'codex', callerPlanMode: true,
    }
    bus.registerRun('run-plan', ctx)

    const client = await connect(path)
    client.send({
      v: 1, type: 'a2a', runId: 'run-plan', reqId: 'r1',
      payload: { agent: 'opencode', prompt: 'go' },
    })
    const res = await client.next()
    expect(res.type).toBe('a2a.result')
    expect(res.ok).toBe(true)
    // The crux: callee opts carried planMode through the bus.
    expect(lastCallOpts?.planMode).toBe(true)
    await client.close()
  })

  it('does NOT set planMode when the run is a normal (write) run', async () => {
    const ctx: RunContext = {
      threadId: 't', platform: 'feishu', userId: 'u', channelId: 'c',
      callerAgent: 'codex', // no callerPlanMode
    }
    bus.registerRun('run-write', ctx)

    const client = await connect(path)
    client.send({
      v: 1, type: 'a2a', runId: 'run-write', reqId: 'r2',
      payload: { agent: 'opencode', prompt: 'go' },
    })
    const res = await client.next()
    expect(res.ok).toBe(true)
    // No plan-mode parent → never inject planMode (would needlessly cripple
    // a legitimate write delegation).
    expect(lastCallOpts?.planMode).toBeUndefined()
    await client.close()
  })
})
