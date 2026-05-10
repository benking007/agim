// /approval command — list / clear in-session auto-allow rules.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { type Socket, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { approvalBus, threadKey, type RunContext } from '../approval-bus.js'
import { handleApprovalCommand } from './approval.js'
import type { RouteContext } from '../router.js'
import type { Logger } from 'pino'

const RUN_CTX: RunContext = { threadId: 'thread-X', platform: 'feishu', userId: 'u', channelId: 'c' }
/** Composite key matching RUN_CTX — bus stores by composite, so direct
 *  lookups in this test must use this exact value. */
const KEY = threadKey(RUN_CTX.platform, RUN_CTX.channelId, RUN_CTX.threadId)

function makeRouteCtx(): RouteContext {
  return {
    channelId: 'c', threadId: 'thread-X', platform: 'feishu',
    defaultAgent: 'claude-code', traceId: 't',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) } as unknown as Logger,
  }
}

function uniqueSocketPath(): string {
  return join(tmpdir(), `imhub-approval-cmd-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function seedRule(socketPath: string, runId: string, reqId: string, toolName: string, command: string): Promise<Socket> {
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(socketPath)
    s.once('error', reject)
    s.once('connect', () => resolve(s))
  })
  sock.setEncoding('utf8')
  sock.on('data', () => { /* drain decisions */ })
  sock.write(`${JSON.stringify({
    v: 1, type: 'approval', runId, reqId, toolName,
    input: { command }, toolUseId: `tu-${reqId}`,
  })}\n`)
  await sleep(20)
  approvalBus.resolvePending(KEY, { behavior: 'allow', autoAllowFurther: true })
  return sock
}

describe('handleApprovalCommand', () => {
  let path: string

  beforeEach(async () => {
    path = uniqueSocketPath()
    await approvalBus.start(path)
    approvalBus.registerRun('run-X', RUN_CTX)
    approvalBus.setNotifier(async () => { /* no-op */ })
  })

  afterEach(async () => {
    approvalBus.clearAutoAllowForThread(KEY)
    await approvalBus.stop()
  })

  it('reports an empty list when no rules exist', async () => {
    const out = await handleApprovalCommand('', makeRouteCtx())
    expect(out).toContain('没有自动放行规则')
    expect(out).toContain('all')
  })

  it('lists active rules with tool + prefix', async () => {
    const sock1 = await seedRule(path, 'run-X', 'r1', 'Bash', 'git status -s')
    const sock2 = await seedRule(path, 'run-X', 'r2', 'Bash', 'rm -rf /tmp/x')
    // M13: AUTO_ALLOW_PREFIX_LEN bumped 5 → 10 so the rule keys carry
    // 10 characters of the input. `git status -s` is 13 chars, prefix10
    // is `git status`; `rm -rf /tmp/x` is 13 chars, prefix10 is
    // `rm -rf /tm`.
    expect(approvalBus.getAutoAllowKeys(KEY).sort()).toEqual([
      'Bash::git status', 'Bash::rm -rf /tm',
    ])

    const out = await handleApprovalCommand('', makeRouteCtx())
    expect(out).toContain('本会话自动放行规则 (2)')
    expect(out).toContain('Bash')
    expect(out).toContain('git status')
    expect(out).toContain('rm -rf')

    sock1.end(); sock2.end()
  })

  it('clear on an empty thread reports "no rules to clear"', async () => {
    const out = await handleApprovalCommand('clear', makeRouteCtx())
    expect(out).toContain('当前没有自动放行规则')
  })

  it('clear drops every rule for this thread', async () => {
    const sock = await seedRule(path, 'run-X', 'rc', 'Bash', 'docker ps')
    expect(approvalBus.getAutoAllowKeys(KEY).length).toBe(1)

    const out = await handleApprovalCommand('clear', makeRouteCtx())
    expect(out).toContain('已清空本会话的 1 条自动放行规则')
    expect(approvalBus.getAutoAllowKeys(KEY)).toEqual([])

    sock.end()
  })

  // ─── /approval readonly subcommand ────────────────────────────────────

  it('readonly: bare subcommand reports current status', async () => {
    // Default-on at process start.
    const out = await handleApprovalCommand('readonly', makeRouteCtx())
    expect(out).toContain('只读自动放行：开启')
    expect(out).toContain('Read')
    expect(out).toContain('readonly off')
  })

  it('readonly off / on toggles the per-thread state', async () => {
    expect(approvalBus.isReadonlyAutoAllowEnabled(KEY)).toBe(true)

    const offOut = await handleApprovalCommand('readonly off', makeRouteCtx())
    expect(offOut).toContain('已关闭')
    expect(approvalBus.isReadonlyAutoAllowEnabled(KEY)).toBe(false)

    const onOut = await handleApprovalCommand('readonly on', makeRouteCtx())
    expect(onOut).toContain('已开启')
    expect(approvalBus.isReadonlyAutoAllowEnabled(KEY)).toBe(true)
  })

  it('readonly: aliases /approval ro on|off', async () => {
    const offOut = await handleApprovalCommand('ro disable', makeRouteCtx())
    expect(offOut).toContain('已关闭')
    expect(approvalBus.isReadonlyAutoAllowEnabled(KEY)).toBe(false)

    const onOut = await handleApprovalCommand('ro enable', makeRouteCtx())
    expect(onOut).toContain('已开启')
    expect(approvalBus.isReadonlyAutoAllowEnabled(KEY)).toBe(true)
  })

  it('bare /approval surfaces readonly status line', async () => {
    const out = await handleApprovalCommand('', makeRouteCtx())
    expect(out).toContain('只读自动放行')
  })
})
