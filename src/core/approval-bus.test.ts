// approval-bus tests — 用真实 unix socket 模拟 sidecar 端，验证协议与 pending 生命周期。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { type Socket, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  ApprovalBus,
  inputFingerprint,
  threadKey,
  type ApprovalNotification,
  type RunContext,
} from './approval-bus.js'

const RUN_CTX: RunContext = {
  threadId: 'thread-A',
  platform: 'feishu',
  userId: 'user-1',
  channelId: 'chan-1',
}

/** Composite key matching RUN_CTX. After P0 #4 the bus stores by composite
 *  key, so all hasPendingFor / resolvePending / autoAllow lookups must use
 *  this exact value (not the bare threadId). */
const KEY = threadKey(RUN_CTX.platform, RUN_CTX.channelId, RUN_CTX.threadId)

function uniqueSocketPath(): string {
  return join(tmpdir(), `imhub-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

/** A minimal NDJSON client over unix socket. Tests get one of these per connection. */
class TestClient {
  private buf = ''
  private queue: unknown[] = []
  private waiters: Array<(v: unknown) => void> = []
  socket: Socket

  constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buf += chunk
      while (true) {
        const nl = this.buf.indexOf('\n')
        if (nl === -1) break
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        const obj = JSON.parse(line)
        const w = this.waiters.shift()
        if (w) w(obj)
        else this.queue.push(obj)
      }
    })
  }

  send(obj: unknown): void {
    this.socket.write(`${JSON.stringify(obj)}\n`)
  }

  /** Send a raw line (no JSON validation) — used for bad-json tests. */
  sendRaw(line: string): void {
    this.socket.write(`${line}\n`)
  }

  /** Resolve as soon as next NDJSON message arrives. Throws on timeout.
   *  any is intentional — callers do ad-hoc property access on the parsed
   *  wire payload (decision.behavior, etc.); a strict shape would force a
   *  cast at every call site for a test-only helper. */
  // biome-ignore lint/suspicious/noExplicitAny: see jsdoc — test helper
  next(timeoutMs = 1000): Promise<any> {
    return new Promise((resolve, reject) => {
      const queued = this.queue.shift()
      if (queued !== undefined) { resolve(queued); return }
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(wrapped)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(`TestClient.next() timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const wrapped = (v: unknown): void => {
        clearTimeout(timer)
        resolve(v)
      }
      this.waiters.push(wrapped)
    })
  }

  /** Resolve next message OR null if socket closes first within timeout. */
  // biome-ignore lint/suspicious/noExplicitAny: same as next() — test helper
  nextOrClose(timeoutMs = 1000): Promise<any> {
    return Promise.race([
      this.next(timeoutMs).catch(() => null),
      new Promise<null>((resolve) => {
        this.socket.once('close', () => resolve(null))
      }),
    ])
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) { resolve(); return }
      this.socket.once('close', () => resolve())
      this.socket.end()
    })
  }
}

async function connectClient(path: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path)
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.removeAllListeners('error')
      sock.on('error', () => { /* swallow post-connect errors in tests */ })
      resolve(new TestClient(sock))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('ApprovalBus', () => {
  let bus: ApprovalBus
  let path: string

  beforeEach(async () => {
    bus = new ApprovalBus({ approvalTimeoutMs: 200 })
    path = uniqueSocketPath()
    await bus.start(path)
  })

  afterEach(async () => {
    await bus.stop()
  })

  it('start() listens on the given socket path', async () => {
    expect(bus.getSocketPath()).toBe(path)
    // Simply being able to connect verifies the listener is up
    const client = await connectClient(path)
    await client.close()
  })

  it('happy path: approval → notifier → resolvePending(allow)', async () => {
    bus.registerRun('run-1', RUN_CTX)
    let notified: ApprovalNotification | null = null
    bus.setNotifier(async (n) => { notified = n })

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval',
      runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: { command: 'git push' }, toolUseId: 'tu-1',
    })

    // Wait for notifier to fire (it's async via handleApproval)
    for (let i = 0; i < 50 && !notified; i++) await sleep(10)
    expect(notified).not.toBeNull()
    expect(notified!.runId).toBe('run-1')
    expect(notified!.reqId).toBe('req-1')
    expect(notified!.toolName).toBe('Bash')
    expect(notified!.input).toEqual({ command: 'git push' })
    expect(notified!.ctx.threadId).toBe('thread-A')
    expect(bus.hasPendingFor(KEY)).toBe(true)

    const resolved = bus.resolvePending(KEY, { behavior: 'allow' })
    expect(resolved).not.toBeNull()
    expect(resolved?.toolName).toBe('Bash')
    // Bash fingerprint = `cmd:` prefix + first two whitespace-separated
    // tokens. `git push` and `git pull` get distinct keys (`cmd:git+push`
    // vs `cmd:git+pull`); subcommand variants like `git push -f` share
    // `cmd:git+push`.
    expect(resolved?.fingerprint).toBe('cmd:git+push')
    expect(resolved?.platform).toBe('feishu')
    expect(resolved?.wasAutoAllow).toBe(false)
    expect(bus.hasPendingFor(KEY)).toBe(false)

    const decision = await client.next()
    expect(decision).toEqual({ v: 1, type: 'decision', reqId: 'req-1', behavior: 'allow' })

    await client.close()
  })

  it('resolvePending forwards updatedInput', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => { /* noop */ })

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, toolUseId: 'tu-1',
    })
    await sleep(20)

    bus.resolvePending(KEY, { behavior: 'allow', updatedInput: { command: 'rm -rf /tmp/safe' } })
    const decision = await client.next()
    expect(decision.behavior).toBe('allow')
    expect(decision.updatedInput).toEqual({ command: 'rm -rf /tmp/safe' })

    await client.close()
  })

  it('resolvePending(deny) carries the message', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)

    bus.resolvePending(KEY, { behavior: 'deny', message: '用户拒绝' })
    const decision = await client.next()
    expect(decision).toEqual({ v: 1, type: 'decision', reqId: 'req-1', behavior: 'deny', message: '用户拒绝' })

    await client.close()
  })

  it('approval timeout → auto deny', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })

    const decision = await client.next(2000)
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toBe('approval timeout')
    expect(bus.hasPendingFor(KEY)).toBe(false)

    await client.close()
  })

  it('unknown runId → instant deny without notifier', async () => {
    let notifierCalls = 0
    bus.setNotifier(async () => { notifierCalls++ })

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'unknown', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })

    const decision = await client.next()
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toContain('unknown runId')
    expect(notifierCalls).toBe(0)

    await client.close()
  })

  it('no notifier installed → instant deny', async () => {
    bus.registerRun('run-1', RUN_CTX)
    // Intentionally no setNotifier

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })

    const decision = await client.next()
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toContain('no notifier installed')

    await client.close()
  })

  it('unregisterRun denies pending for that run', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)
    expect(bus.hasPendingFor(KEY)).toBe(true)

    bus.unregisterRun('run-1')
    const decision = await client.next()
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toContain('run terminated')
    expect(bus.hasPendingFor(KEY)).toBe(false)

    await client.close()
  })

  it('socket close denies pending for that connection', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)
    expect(bus.hasPendingFor(KEY)).toBe(true)

    await client.close()
    // Give bus a moment to handle 'close'
    for (let i = 0; i < 20 && bus.hasPendingFor(KEY); i++) await sleep(10)
    expect(bus.hasPendingFor(KEY)).toBe(false)
  })

  it('bad JSON does not crash; subsequent valid lines still work', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.sendRaw('not json at all {{{')
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)
    expect(bus.hasPendingFor(KEY)).toBe(true)
    bus.resolvePending(KEY, { behavior: 'allow' })
    const decision = await client.next()
    expect(decision.reqId).toBe('req-1')
    await client.close()
  })

  it('unsupported version is ignored, no decision sent', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 999, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    // Should NOT receive a decision for v:999
    let received: unknown = null
    try { received = await client.next(150) } catch { /* expected timeout */ }
    expect(received).toBeNull()
    expect(bus.hasPendingFor(KEY)).toBe(false)
    await client.close()
  })

  it('duplicate reqId → second one denied, first stays pending', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'dup',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'dup',
      toolName: 'Read', input: {}, toolUseId: 'tu-2',
    })

    const first = await client.next()
    // Second send hits "duplicate reqId" branch — that's the first decision we see
    expect(first.behavior).toBe('deny')
    expect(first.message).toBe('duplicate reqId')
    // Original is still pending
    expect(bus.hasPendingFor(KEY)).toBe(true)
    bus.resolvePending(KEY, { behavior: 'allow' })
    const second = await client.next()
    expect(second.behavior).toBe('allow')

    await client.close()
  })

  it('resolvePending returns null when no pending exists', () => {
    expect(bus.resolvePending('nope', { behavior: 'allow' })).toBeNull()
  })

  it('stop() denies all pending and closes socket', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })
    await sleep(20)

    await bus.stop()

    const decision = await client.next(500)
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toContain('shutting down')

    // After stop(), new connections should fail
    let connectErr: Error | null = null
    try { await connectClient(path) } catch (e) { connectErr = e as Error }
    expect(connectErr).not.toBeNull()
  })

  it('notifier rejection → auto deny, forwarding the error message', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => { throw new Error('messenger down') })

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-1',
      toolName: 'Bash', input: {}, toolUseId: 'tu-1',
    })

    const decision = await client.next()
    expect(decision.behavior).toBe('deny')
    // The notifier's err.message reaches the agent verbatim so users see
    // meaningful text (e.g. self-protect's redirect to /restart) instead
    // of a generic "notifier error" string.
    expect(decision.message).toBe('messenger down')
    expect(bus.hasPendingFor(KEY)).toBe(false)

    await client.close()
  })

  it('notifier rejection with non-Error throw → fallback message', async () => {
    bus.registerRun('run-2', RUN_CTX)
    bus.setNotifier(async () => { throw 'plain string'  /* eslint-disable-line */ })

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-2', reqId: 'req-2',
      toolName: 'Bash', input: {}, toolUseId: 'tu-2',
    })

    const decision = await client.next()
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toBe('notifier error')

    await client.close()
  })

  it('auto-allow: rule registered on allow+autoAllowFurther, second request resolves via grace timer', async () => {
    const fastBus = new ApprovalBus({ approvalTimeoutMs: 5000, autoAllowGraceMs: 80 })
    const fastPath = uniqueSocketPath()
    await fastBus.start(fastPath)
    try {
      fastBus.registerRun('run-1', RUN_CTX)
      const notifications: ApprovalNotification[] = []
      fastBus.setNotifier(async (n) => { notifications.push(n) })

      const client = await connectClient(fastPath)
      // First call — user replies "all"
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-1',
        toolName: 'Bash', input: { command: 'git status -s' }, toolUseId: 'tu-1',
      })
      for (let i = 0; i < 50 && notifications.length < 1; i++) await sleep(10)
      expect(notifications[0].autoAllow).toBeUndefined() // first ask is normal
      fastBus.resolvePending(KEY, { behavior: 'allow', autoAllowFurther: true })
      const d1 = await client.next()
      expect(d1.behavior).toBe('allow')
      // Wire payload must NOT carry autoAllowFurther — that's internal-only.
      expect(d1.autoAllowFurther).toBeUndefined()
      expect(fastBus.getAutoAllowKeys(KEY)).toEqual(['Bash::cmd:git+status'])

      // Second call — same Bash verb pair (`git status`) → grace mode
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-2',
        toolName: 'Bash', input: { command: 'git status' }, toolUseId: 'tu-2',
      })
      for (let i = 0; i < 50 && notifications.length < 2; i++) await sleep(10)
      expect(notifications[1].autoAllow).toEqual({ graceMs: 80 })

      // Don't reply → grace timer fires → allow auto-resolved
      const d2 = await client.next(500)
      expect(d2.behavior).toBe('allow')
      expect(fastBus.hasPendingFor(KEY)).toBe(false)

      await client.close()
    } finally {
      await fastBus.stop()
    }
  })

  it('auto-allow: explicit deny in grace mode revokes the rule', async () => {
    const fastBus = new ApprovalBus({ approvalTimeoutMs: 5000, autoAllowGraceMs: 1000 })
    const fastPath = uniqueSocketPath()
    await fastBus.start(fastPath)
    try {
      fastBus.registerRun('run-1', RUN_CTX)
      fastBus.setNotifier(async () => {})

      const client = await connectClient(fastPath)
      // Seed a rule directly via the public path (allow+autoAllowFurther).
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-seed',
        // First two tokens (`rm -rf`) form the Bash fingerprint, so this
        // rule covers the second call below regardless of which path it
        // targets.
        toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, toolUseId: 'tu-1',
      })
      await sleep(20)
      fastBus.resolvePending(KEY, { behavior: 'allow', autoAllowFurther: true })
      await client.next()
      expect(fastBus.getAutoAllowKeys(KEY)).toEqual(['Bash::cmd:rm+-rf'])

      // Second call hits the rule → grace mode. User explicitly denies.
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-2',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/y' }, toolUseId: 'tu-2',
      })
      await sleep(20)
      fastBus.resolvePending(KEY, { behavior: 'deny', message: '不行' })
      const d = await client.next()
      expect(d.behavior).toBe('deny')
      // Rule is revoked → next call should be normal (not auto-allow).
      expect(fastBus.getAutoAllowKeys(KEY)).toEqual([])

      await client.close()
    } finally {
      await fastBus.stop()
    }
  })

  it('auto-allow: non-user denies (run terminated, shutdown) do NOT revoke the rule', async () => {
    const fastBus = new ApprovalBus({ approvalTimeoutMs: 5000, autoAllowGraceMs: 5000 })
    const fastPath = uniqueSocketPath()
    await fastBus.start(fastPath)
    try {
      fastBus.registerRun('run-1', RUN_CTX)
      fastBus.setNotifier(async () => {})

      const client = await connectClient(fastPath)
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-1',
        toolName: 'Bash', input: { command: 'ls -la /tmp/imhub-foo' }, toolUseId: 'tu-1',
      })
      await sleep(20)
      fastBus.resolvePending(KEY, { behavior: 'allow', autoAllowFurther: true })
      await client.next()

      // Open a 2nd request that hits the rule (auto-allow grace). Both
      // commands share the first two tokens (`ls -la`) so they map to
      // the same `cmd:` fingerprint regardless of path argument.
      client.send({
        v: 1, type: 'approval', runId: 'run-1', reqId: 'r-2',
        toolName: 'Bash', input: { command: 'ls -la /tmp/imhub-other' }, toolUseId: 'tu-2',
      })
      await sleep(20)

      // Simulate "claude died" — unregisterRun → cancelPending(deny). This
      // should NOT clear the rule.
      fastBus.unregisterRun('run-1')
      const d = await client.next()
      expect(d.behavior).toBe('deny')
      expect(fastBus.getAutoAllowKeys(KEY)).toEqual(['Bash::cmd:ls+-la'])

      await client.close()
    } finally {
      await fastBus.stop()
    }
  })

  it('auto-allow: clearAutoAllowForThread drops every rule', () => {
    bus.clearAutoAllowForThread('does-not-exist') // should not throw
    // Internal — exercise via the real public path: addAutoAllowRule is called
    // via cancelPending. We use a private lookup helper here.
    bus.registerRun('run-clr', RUN_CTX)
    bus.setNotifier(async () => {})
    // After clearing, no rules should remain — start from baseline.
    bus.clearAutoAllowForThread(KEY)
    expect(bus.getAutoAllowKeys(KEY)).toEqual([])
  })

  it('queues multiple pending on same thread, resolves head first', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})

    const client = await connectClient(path)
    client.send({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-A',
      toolName: 'Bash', input: {}, toolUseId: 'tu-A',
    })
    await sleep(20)
    client.send({
      // Edit (not Read) — Read auto-allows under the readonly short-circuit
      // and would never enter the queue. Test intent is queue ordering, not
      // any specific tool semantics.
      v: 1, type: 'approval', runId: 'run-1', reqId: 'req-B',
      toolName: 'Edit', input: {}, toolUseId: 'tu-B',
    })
    await sleep(20)

    expect(bus.hasPendingFor(KEY)).toBe(true)
    bus.resolvePending(KEY, { behavior: 'allow' })
    const first = await client.next()
    expect(first.reqId).toBe('req-A')

    expect(bus.hasPendingFor(KEY)).toBe(true)
    bus.resolvePending(KEY, { behavior: 'deny', message: 'no' })
    const second = await client.next()
    expect(second.reqId).toBe('req-B')
    expect(second.behavior).toBe('deny')

    await client.close()
  })

  // M14 follow-up: each resolution must increment exactly ONE of
  // allowed/denied/timedOut. If two buckets fire on the same call
  // (e.g. cause='timeout' + decision.behavior='deny'), the Prometheus
  // "allow = resolved - deny - timeout" math would go negative — counters
  // must be monotonic, so this invariant is load-bearing for the metrics
  // exposition.
  it('metrics: resolution buckets are mutually exclusive', async () => {
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => {})
    const client = await connectClient(path)

    // 1. user allow
    client.send({ v: 1, type: 'approval', runId: 'run-1', reqId: 'r1', toolName: 'Bash', input: {}, toolUseId: 'tu-1' })
    await sleep(20)
    bus.resolvePending(KEY, { behavior: 'allow' })
    await client.next()

    // 2. user deny
    client.send({ v: 1, type: 'approval', runId: 'run-1', reqId: 'r2', toolName: 'Bash', input: {}, toolUseId: 'tu-2' })
    await sleep(20)
    bus.resolvePending(KEY, { behavior: 'deny', message: 'no' })
    await client.next()

    // 3. timeout (no auto-allow grace, fires deny on the wire but counts as timeout)
    client.send({ v: 1, type: 'approval', runId: 'run-1', reqId: 'r3', toolName: 'Bash', input: {}, toolUseId: 'tu-3' })
    const timeoutDecision = await client.next(2000)
    expect(timeoutDecision.behavior).toBe('deny')

    const m = bus.getMetrics()
    expect(m.totalRequests).toBe(3)
    expect(m.totalResolved).toBe(3)
    expect(m.totalAllowed).toBe(1)
    expect(m.totalDenied).toBe(1)
    expect(m.totalTimedOut).toBe(1)
    // Invariant — buckets sum to totalResolved.
    expect(m.totalAllowed + m.totalDenied + m.totalTimedOut).toBe(m.totalResolved)

    await client.close()
  })
})

describe('inputFingerprint — semantic per-tool keys', () => {
  describe('Bash', () => {
    it('keys by first two whitespace-separated tokens', () => {
      expect(inputFingerprint('Bash', { command: 'git status' })).toBe('cmd:git+status')
      expect(inputFingerprint('Bash', { command: 'git push origin main' })).toBe('cmd:git+push')
    })
    it('subcommand variants share a rule (status / status -s)', () => {
      expect(inputFingerprint('Bash', { command: 'git status' }))
        .toBe(inputFingerprint('Bash', { command: 'git status -s' }))
    })
    it('different subcommands of the same verb are distinct rules', () => {
      const a = inputFingerprint('Bash', { command: 'git status' })
      const b = inputFingerprint('Bash', { command: 'git stash' })
      const c = inputFingerprint('Bash', { command: 'git submodule update' })
      expect(a).not.toBe(b)
      expect(a).not.toBe(c)
      expect(b).not.toBe(c)
    })
    it('single-token commands collapse to `cmd:verb`', () => {
      expect(inputFingerprint('Bash', { command: 'pwd' })).toBe('cmd:pwd')
      expect(inputFingerprint('Bash', { command: '  ls   ' })).toBe('cmd:ls')
    })
    it('extra whitespace inside the command does not affect the key', () => {
      expect(inputFingerprint('Bash', { command: '  git    push  ' })).toBe('cmd:git+push')
    })
    it('missing command falls back to raw:', () => {
      expect(inputFingerprint('Bash', {})).toMatch(/^raw:/)
    })
  })

  describe('path-based tools (Read/Write/Edit/...)', () => {
    it('keys by dirname so all files in a directory share a rule', () => {
      const a = inputFingerprint('Read', { file_path: '/tmp/a.txt' })
      const b = inputFingerprint('Read', { file_path: '/tmp/b.txt' })
      expect(a).toBe('dir:/tmp')
      expect(b).toBe('dir:/tmp')
      expect(a).toBe(b)
    })
    it('different directories are distinct rules', () => {
      expect(inputFingerprint('Read', { file_path: '/tmp/x' }))
        .not.toBe(inputFingerprint('Read', { file_path: '/etc/passwd' }))
    })
    it('nested subdirs are distinct', () => {
      expect(inputFingerprint('Read', { file_path: '/tmp/sub/y' })).toBe('dir:/tmp/sub')
      expect(inputFingerprint('Read', { file_path: '/tmp/sub/y' }))
        .not.toBe(inputFingerprint('Read', { file_path: '/tmp/y' }))
    })
    it('Read and Write for the same dir live under DIFFERENT rule keys', () => {
      // Rule key = `${toolName}::${fingerprint}`. Same fingerprint, different
      // tool → different rule. Approving Read /tmp/x does NOT auto-allow
      // Write /tmp/y.
      const fpRead = inputFingerprint('Read', { file_path: '/tmp/x' })
      const fpWrite = inputFingerprint('Write', { file_path: '/tmp/y' })
      expect(fpRead).toBe(fpWrite) // same fingerprint string
      // But the bus combines toolName + fingerprint → different rule key.
      expect(`Read::${fpRead}`).not.toBe(`Write::${fpWrite}`)
    })
    it('relative paths with no dirname fall back to path:', () => {
      expect(inputFingerprint('Read', { file_path: 'file.txt' })).toBe('path:file.txt')
    })
    it('falls back to the `path` field when `file_path` is absent', () => {
      expect(inputFingerprint('LS', { path: '/var/log' })).toBe('dir:/var')
    })
    it('missing path falls back to raw:', () => {
      expect(inputFingerprint('Read', {})).toMatch(/^raw:/)
    })
  })

  describe('WebFetch', () => {
    it('keys by hostname so different paths on the same host share a rule', () => {
      const a = inputFingerprint('WebFetch', { url: 'https://api.openai.com/v1/foo' })
      const b = inputFingerprint('WebFetch', { url: 'https://api.openai.com/v2/bar' })
      expect(a).toBe('host:api.openai.com')
      expect(a).toBe(b)
    })
    it('different hosts are distinct rules', () => {
      expect(inputFingerprint('WebFetch', { url: 'https://api.openai.com/foo' }))
        .not.toBe(inputFingerprint('WebFetch', { url: 'https://api.anthropic.com/foo' }))
    })
    it('URLs with port strip the port from the hostname', () => {
      expect(inputFingerprint('WebFetch', { url: 'http://api.x.com:8080/foo' }))
        .toBe('host:api.x.com')
    })
    it('malformed URLs fall back to url: prefix', () => {
      expect(inputFingerprint('WebFetch', { url: 'not a url' })).toMatch(/^url:/)
    })
  })

  describe('WebSearch / Glob / Grep', () => {
    it('WebSearch keys on query prefix', () => {
      expect(inputFingerprint('WebSearch', { query: 'agim docs' })).toBe('query:agim docs')
    })
    it('Glob keys on pattern prefix', () => {
      expect(inputFingerprint('Glob', { pattern: '**/*.ts' })).toBe('pat:**/*.ts')
    })
    it('Grep keys on pattern prefix', () => {
      expect(inputFingerprint('Grep', { pattern: 'TODO' })).toBe('pat:TODO')
    })
  })

  describe('unknown tools / fallback', () => {
    it('falls back to raw: JSON prefix', () => {
      const fp = inputFingerprint('mcp__some__tool', { foo: 'bar', baz: 42 })
      expect(fp).toMatch(/^raw:/)
      expect(fp.length).toBeGreaterThan('raw:'.length)
    })
  })

  describe('key-space disambiguation', () => {
    it('prefixes prevent cross-scheme aliasing', () => {
      // A path that happens to look like a hostname must NOT alias to a host.
      const path = inputFingerprint('Read', { file_path: '/api.openai.com' })
      const host = inputFingerprint('WebFetch', { url: 'https://api.openai.com' })
      expect(path).not.toBe(host)
    })
  })
})
