// approval-router tests — parser, formatter, install/uninstall, and an
// end-to-end loop where install() wires real ApprovalBus → fake messenger →
// tryHandleApprovalReply → bus delivers Decision back to the caller.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { type Socket, createConnection } from 'node:net'
import {
  ApprovalBus,
  approvalBus,
  type ApprovalNotification,
  type Decision,
  type RunContext,
} from './approval-bus.js'
import { threadKey } from './approval-bus.js'
import { registry } from './registry.js'
import {
  parseApprovalReply,
  formatApprovalPrompt,
  platformToMessengerName,
  install,
  uninstall,
  tryHandleApprovalReply,
  bindButtonHandlerForPlatform,
} from './approval-router.js'
import type { MessengerAdapter, ButtonCallback, ApprovalCardOutcome } from './types.js'
import { handleAskOp, _resetAskBusForTests } from './ask-user-rpc.js'

const RUN_CTX: RunContext = { threadId: 'thread-A', platform: 'feishu', userId: 'u1', channelId: 'c1' }
/** Composite key matching RUN_CTX. After P0 #4 the bus stores by composite
 *  key, so all bus lookups (and the cli's tryHandleApprovalReply) must pass
 *  this exact value rather than the bare threadId. */
const KEY = threadKey(RUN_CTX.platform, RUN_CTX.channelId, RUN_CTX.threadId)

function uniqueSocketPath(): string {
  return join(tmpdir(), `agim-router-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

describe('parseApprovalReply', () => {
  it.each([
    ['y', 'allow'], ['Y', 'allow'], ['yes', 'allow'], ['YES', 'allow'],
    ['ok', 'allow'], ['1', 'allow'], ['批准', 'allow'], ['同意', 'allow'],
    ['通过', 'allow'], ['可以', 'allow'], ['✅', 'allow'],
    ['  y  ', 'allow'],   // whitespace
    ['/y', 'allow'],      // telegram-style slash
  ])('classifies %s as %s', (input, expected) => {
    const r = parseApprovalReply(input)
    expect(r?.behavior).toBe(expected as 'allow' | 'deny')
  })

  it.each([
    ['n', 'deny'], ['N', 'deny'], ['no', 'deny'], ['0', 'deny'],
    ['拒绝', 'deny'], ['不同意', 'deny'], ['不可以', 'deny'], ['不', 'deny'], ['❌', 'deny'],
  ])('classifies %s as %s', (input, expected) => {
    const r = parseApprovalReply(input)
    expect(r?.behavior).toBe(expected as 'allow' | 'deny')
  })

  it.each([
    [''], ['   '], ['hello'], ['why are you asking me'], ['yes please proceed'], ['n.b. read this first'],
  ])('returns null for non-decision reply %p', (input) => {
    expect(parseApprovalReply(input)).toBeNull()
  })

  it('deny decisions carry a default message', () => {
    const r = parseApprovalReply('n') as { behavior: 'deny'; message: string }
    expect(r.behavior).toBe('deny')
    expect(r.message).toContain('用户')
  })

  it.each([
    ['all'], ['ALL'], ['a'], ['全部'], ['总是'], ['都同意'], ['都批准'],
    ['  all  '], ['/all'],
  ])('parses %p as allow + autoAllowFurther', (input) => {
    const r = parseApprovalReply(input) as Decision & { autoAllowFurther?: boolean }
    expect(r?.behavior).toBe('allow')
    expect(r?.autoAllowFurther).toBe(true)
  })
})

describe('formatApprovalPrompt — auto-allow grace mode', () => {
  it('renders a softer prompt with countdown when n.autoAllow is set', () => {
    const n: ApprovalNotification = {
      runId: 'r', reqId: 'abcdef0123', toolName: 'Bash',
      input: { command: 'ls -la' }, toolUseId: 'tu', ctx: RUN_CTX,
      autoAllow: { graceMs: 5000 },
    }
    const text = formatApprovalPrompt(n)
    expect(text).toContain('5s')
    expect(text).toContain('自动放行')
    expect(text).toContain('n')   // still tells user how to reject
    expect(text).toContain('Bash')
    expect(text).toContain('ls -la')
  })
})

describe('platformToMessengerName', () => {
  it('maps wechat → wechat-ilink, others pass through', () => {
    expect(platformToMessengerName('wechat')).toBe('wechat-ilink')
    expect(platformToMessengerName('feishu')).toBe('feishu')
    expect(platformToMessengerName('telegram')).toBe('telegram')
  })
})

describe('formatApprovalPrompt', () => {
  it('renders a multi-line prompt with tool name, input preview, and short reqId', () => {
    const n: ApprovalNotification = {
      runId: 'run-1', reqId: 'abcdef0123456789',
      toolName: 'Bash', input: { command: 'git push' }, toolUseId: 'tu-1',
      ctx: RUN_CTX,
    }
    const text = formatApprovalPrompt(n)
    expect(text).toContain('Bash')
    expect(text).toContain('git push')
    expect(text).toContain('abcdef01') // 8-char reqId prefix
    expect(text).toContain('y') // includes hint
    expect(text).toContain('n')
  })

  it('truncates very long input', () => {
    const big = 'x'.repeat(2000)
    const n: ApprovalNotification = {
      runId: 'r', reqId: 'r1', toolName: 'Bash',
      input: { command: big }, toolUseId: 'tu', ctx: RUN_CTX,
    }
    const text = formatApprovalPrompt(n)
    expect(text.length).toBeLessThan(2000)
    expect(text).toContain('…')
  })
})

describe('tryHandleApprovalReply', () => {
  let bus: ApprovalBus
  let path: string
  let connectedSock: Socket

  // Use the singleton's setNotifier API (what install() touches under the
  // hood). Tests here drive approvalBus directly; the real install() flow is
  // exercised in the integration block below.
  beforeEach(async () => {
    path = uniqueSocketPath()
    bus = new ApprovalBus({ approvalTimeoutMs: 1000 })
    await bus.start(path)
    bus.registerRun('run-1', RUN_CTX)
    bus.setNotifier(async () => { /* no-op: we'll seed pending manually below */ })

    // Seed a pending so hasPendingFor(KEY) is true.
    connectedSock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    connectedSock.write(`${JSON.stringify({
      v: 1, type: 'approval', runId: 'run-1', reqId: 'pending-1',
      toolName: 'Bash', input: { command: 'git status' }, toolUseId: 'tu',
    })}\n`)
    // Give bus a tick to enqueue
    await new Promise((r) => setTimeout(r, 30))
    expect(bus.hasPendingFor(KEY)).toBe(true)
  })

  afterEach(async () => {
    connectedSock.end()
    await bus.stop()
    uninstall()
  })

  it('returns false when no pending exists for the thread', () => {
    // Use a different composite key — no pending there
    expect(tryHandleApprovalReply(threadKey('feishu', 'c1', 'other-thread'), 'y')).toBe(false)
    // The original pending is still there
    expect(bus.hasPendingFor(KEY)).toBe(true)
  })

  // The following two tests must use the singleton bus, since
  // tryHandleApprovalReply targets approvalBus (not our private bus).
  // We swap the singleton's pending-tracker via setNotifier on it directly
  // would be invasive — instead, route through the real install() integration
  // block below. So skip the direct assertions here.

  it('routes "redirect" reply (non-y/n) to false but auto-denies pending', async () => {
    // Wire singleton so tryHandleApprovalReply queries it. We bridge
    // hasPendingFor / resolvePending to our private bus for this test.
    const origHasPending = approvalBus.hasPendingFor.bind(approvalBus)
    const origResolve = approvalBus.resolvePending.bind(approvalBus)
    approvalBus.hasPendingFor = (tid: string) => bus.hasPendingFor(tid)
    approvalBus.resolvePending = (tid: string, d: Decision) => bus.resolvePending(tid, d)
    try {
      const consumed = tryHandleApprovalReply(KEY, 'do something completely different')
      expect(consumed).toBe(false)
      // pending should now be drained (auto-deny)
      expect(bus.hasPendingFor(KEY)).toBe(false)
    } finally {
      approvalBus.hasPendingFor = origHasPending
      approvalBus.resolvePending = origResolve
    }
  })

  it('y reply consumes the message and resolves pending with allow', async () => {
    const origHasPending = approvalBus.hasPendingFor.bind(approvalBus)
    const origResolve = approvalBus.resolvePending.bind(approvalBus)
    let resolvedWith: Decision | null = null
    approvalBus.hasPendingFor = (tid: string) => bus.hasPendingFor(tid)
    approvalBus.resolvePending = (tid: string, d: Decision) => {
      resolvedWith = d
      return bus.resolvePending(tid, d)
    }
    try {
      const consumed = tryHandleApprovalReply(KEY, 'y')
      expect(consumed).toBe(true)
      expect(resolvedWith).not.toBeNull()
      expect((resolvedWith as unknown as Decision).behavior).toBe('allow')
    } finally {
      approvalBus.hasPendingFor = origHasPending
      approvalBus.resolvePending = origResolve
    }
  })
})

describe('install / uninstall — full loop with fake messenger', () => {
  it('end-to-end: sidecar approval → notifier sendMessage → user reply → decision back', async () => {
    const path = uniqueSocketPath()
    // Install on the singleton (what cli.ts does in production)
    await approvalBus.start(path)
    approvalBus.registerRun('run-int', RUN_CTX)

    let lastSentTo: { threadId: string; text: string } | null = null
    const fakeMessenger: MessengerAdapter = {
      name: 'feishu',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async (threadId, text) => { lastSentTo = { threadId, text } },
    }
    install({ resolveMessenger: () => fakeMessenger })

    // Sidecar end: connect, send approval
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')

    const decisions: unknown[] = []
    sock.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) decisions.push(JSON.parse(line))
      }
    })

    sock.write(`${JSON.stringify({
      v: 1, type: 'approval', runId: 'run-int', reqId: 'rint-1',
      toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, toolUseId: 'tu-int',
    })}\n`)

    // Wait for messenger sendMessage
    for (let i = 0; i < 50 && !lastSentTo; i++) await new Promise((r) => setTimeout(r, 10))
    expect(lastSentTo).not.toBeNull()
    expect(lastSentTo!.threadId).toBe('thread-A')
    expect(lastSentTo!.text).toContain('Bash')
    expect(lastSentTo!.text).toContain('rm -rf')

    // User replies "y" via cli's onMessage path
    const consumed = tryHandleApprovalReply(KEY, 'y')
    expect(consumed).toBe(true)

    // Sidecar should receive a decision shortly
    for (let i = 0; i < 50 && decisions.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(decisions.length).toBe(1)
    expect((decisions[0] as { behavior: string }).behavior).toBe('allow')

    sock.end()
    uninstall()
    await approvalBus.stop()
  })

  it('receipt: replying "all" sends a confirmation message back to the thread', async () => {
    const path = uniqueSocketPath()
    await approvalBus.start(path)
    approvalBus.registerRun('run-rcpt', RUN_CTX)

    const sent: Array<{ threadId: string; text: string }> = []
    const fakeMessenger: MessengerAdapter = {
      name: 'feishu',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async (threadId, text) => { sent.push({ threadId, text }) },
    }
    install({ resolveMessenger: () => fakeMessenger })

    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')
    sock.on('data', () => { /* don't care */ })

    sock.write(`${JSON.stringify({
      v: 1, type: 'approval', runId: 'run-rcpt', reqId: 'r-rcpt-1',
      toolName: 'Bash', input: { command: 'git status -s' }, toolUseId: 'tu',
    })}\n`)

    // Wait for approval prompt
    for (let i = 0; i < 50 && sent.length < 1; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sent.length).toBe(1)
    expect(sent[0].text).toContain('🔐')

    // User replies "all" → receipt should be sent in addition to (silent) decision
    const consumed = tryHandleApprovalReply(KEY, 'all')
    expect(consumed).toBe(true)
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sent.length).toBe(2)
    expect(sent[1].text).toContain('已批准并启用自动放行')
    expect(sent[1].text).toContain('Bash')
    expect(sent[1].text).toContain('git status') // 10-char prefix (M13)

    sock.end()
    uninstall()
    await approvalBus.stop()
  })

  it('receipt: denying during grace mode sends "已撤销自动放行规则" message', async () => {
    const path = uniqueSocketPath()
    // tight grace so the second request immediately enters auto-allow mode
    const localBus = approvalBus
    await localBus.start(path)
    localBus.registerRun('run-rev', RUN_CTX)

    const sent: Array<{ threadId: string; text: string }> = []
    const fakeMessenger: MessengerAdapter = {
      name: 'feishu',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async (threadId, text) => { sent.push({ threadId, text }) },
    }
    install({ resolveMessenger: () => fakeMessenger })

    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')
    sock.on('data', () => {})

    // Seed the rule
    sock.write(`${JSON.stringify({
      v: 1, type: 'approval', runId: 'run-rev', reqId: 'rev-1',
      toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, toolUseId: 'tu',
    })}\n`)
    for (let i = 0; i < 50 && sent.length < 1; i++) await new Promise((r) => setTimeout(r, 10))
    tryHandleApprovalReply(KEY, 'all')
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sent[1].text).toContain('已批准并启用自动放行')

    // Second request → should hit the rule (grace mode)
    sock.write(`${JSON.stringify({
      v: 1, type: 'approval', runId: 'run-rev', reqId: 'rev-2',
      toolName: 'Bash', input: { command: 'rm -rf /tmp/y' }, toolUseId: 'tu2',
    })}\n`)
    for (let i = 0; i < 50 && sent.length < 3; i++) await new Promise((r) => setTimeout(r, 10))
    // Plain-text auto-allow header — compact form, just "自动放行 · <tool> · ...".
    expect(sent[2].text).toContain('自动放行')

    // User actively denies → receipt confirms revocation
    tryHandleApprovalReply(KEY, 'n')
    for (let i = 0; i < 50 && sent.length < 4; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sent[3].text).toContain('已拒绝并撤销自动放行')
    expect(localBus.getAutoAllowKeys(KEY)).toEqual([])

    sock.end()
    uninstall()
    await approvalBus.stop()
  })

  it('install with no messenger for platform → bus auto-denies', async () => {
    const path = uniqueSocketPath()
    await approvalBus.start(path)
    approvalBus.registerRun('run-empty', RUN_CTX)
    install({ resolveMessenger: () => undefined }) // never resolves

    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path)
      s.once('error', reject)
      s.once('connect', () => resolve(s))
    })
    sock.setEncoding('utf8')
    const got: unknown[] = []
    sock.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) got.push(JSON.parse(line))
      }
    })

    sock.write(`${JSON.stringify({
      v: 1, type: 'approval', runId: 'run-empty', reqId: 'r-empty',
      toolName: 'Bash', input: {}, toolUseId: 'tu',
    })}\n`)

    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(got.length).toBe(1)
    const d = got[0] as { behavior: string; message?: string }
    expect(d.behavior).toBe('deny')

    sock.end()
    uninstall()
    await approvalBus.stop()
  })
})

// Regression: web messenger registers AFTER installApprovalRouter in cli.ts
// (router needs the registry, but the web adapter needs the WS server to
// exist — chicken-and-egg). install()'s default platform-loop runs ONCE
// at install time and silently skips platforms whose messenger isn't yet
// registered. Without bindButtonHandlerForPlatform, in-page approval card
// clicks fired WS 'approval-action' but had no handler on the server side
// — the card just sat there and the user gave up. This test pins the
// "register late, then bind" pattern that web/server.ts now uses.
describe('bindButtonHandlerForPlatform — late-registered messenger', () => {
  beforeEach(async () => {
    await approvalBus.start(uniqueSocketPath())
    approvalBus.registerRun('run-late', { threadId: 'thread-late', platform: 'web', userId: 'u', channelId: 'c' })
  })
  afterEach(async () => {
    uninstall()
    await approvalBus.stop()
  })

  it('binds the click handler when the messenger appears post-install', async () => {
    // No messenger registered yet — install picks up nothing for 'web'.
    const messengers = new Map<string, MessengerAdapter>()
    install({ resolveMessenger: (p) => messengers.get(p) })

    let buttonHandler: ((cb: ButtonCallback) => Promise<void>) | undefined
    const fakeWeb: MessengerAdapter = {
      name: 'web',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async () => {},
      onButtonCallback: (h) => { buttonHandler = h },
    }
    expect(buttonHandler).toBeUndefined() // not bound yet

    // Late-register, then call the public binder — exactly the cli.ts /
    // server.ts sequence post-fix.
    messengers.set('web', fakeWeb)
    bindButtonHandlerForPlatform('web')
    expect(buttonHandler).toBeDefined()
  })

  it('is a safe no-op when router is not installed', () => {
    // No install() call here — bindButtonHandlerForPlatform must not throw.
    expect(() => bindButtonHandlerForPlatform('web')).not.toThrow()
  })

  it('is a safe no-op when the messenger has no onButtonCallback', () => {
    const messengers = new Map<string, MessengerAdapter>([
      ['no-buttons', {
        name: 'no-buttons',
        start: async () => {},
        stop: async () => {},
        onMessage: () => {},
        sendMessage: async () => {},
      }],
    ])
    install({ resolveMessenger: (p) => messengers.get(p) })
    expect(() => bindButtonHandlerForPlatform('no-buttons')).not.toThrow()
  })
})

describe('button callback dispatch — ask_user cards', () => {
  afterEach(() => {
    uninstall()
    _resetAskBusForTests()
  })

  it('routes ask:* callback data to ask-user resolver without touching approval pending', async () => {
    const ASK_PLATFORM = 'ask-telegram'
    let buttonHandler: ((cb: ButtonCallback) => Promise<void>) | undefined
    const cards: Array<{ data: string }> = []
    const fakeTelegram: MessengerAdapter = {
      name: ASK_PLATFORM,
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async () => {},
      sendChoiceCard: async (_threadId, prompt) => {
        cards.push({ data: prompt.choices[0]?.data ?? '' })
        return { messageId: 'ask-card-1' }
      },
      onButtonCallback: (h) => { buttonHandler = h },
    }
    registry.registerMessenger(fakeTelegram)
    install({
      resolveMessenger: (p) => p === ASK_PLATFORM ? fakeTelegram : undefined,
      buttonCallbackPlatforms: [ASK_PLATFORM],
    })
    const askPromise = handleAskOp(
      { question: '请选择', choices: ['是', '否'], timeoutSec: 5 },
      { platform: ASK_PLATFORM, channelId: 'c-ask', threadId: 't-ask', userId: 'u-ask' },
    )
    await new Promise<void>((r) => setImmediate(r))
    expect(buttonHandler).toBeDefined()
    expect(cards.length).toBe(1)
    const askData = cards[0]?.data
    expect(askData).toBeTruthy()

    let ackText = ''
    await buttonHandler!({
      data: askData!,
      threadId: 't-ask',
      userId: 'u-ask',
      messageId: 'ask-card-1',
      ack: async (text) => { ackText = text ?? '' },
    })

    const result = await askPromise
    expect(ackText).toBe('✓')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.index).toBe(1)
      expect(result.result.via).toBe('button')
    }
  })
})

// v1.2.113 — Regression: clicking a card whose pending is gone (bus
// auto-resolved + WS dropped the edit, OR agim restarted) used to do
// NOTHING — the !info branch had an `activeCards.has(reqId)` guard
// that was false in both cases. User's card stayed at "已发送，等待
// 结果..." forever; a second click also did nothing. The fix: always
// fire editApprovalCard in the !info branch using cb.threadId +
// cb.messageId from the live click event (both trustworthy — the
// platform passed them).
describe('handleButtonCallback — orphan click (v1.2.113 regression)', () => {
  beforeEach(async () => {
    await approvalBus.start(uniqueSocketPath())
  })
  afterEach(async () => {
    uninstall()
    await approvalBus.stop()
  })

  it('fires editApprovalCard with decision=expired when reqId is not in bus or activeCards', async () => {
    let buttonHandler: ((cb: ButtonCallback) => Promise<void>) | undefined
    const edits: Array<{ threadId: string; messageId: string; outcome: ApprovalCardOutcome }> = []
    let acked: string | undefined
    const fakeWeb: MessengerAdapter = {
      name: 'web',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async () => {},
      onButtonCallback: (h) => { buttonHandler = h },
      editApprovalCard: async (threadId, messageId, outcome) => {
        edits.push({ threadId, messageId, outcome })
      },
    }
    install({ resolveMessenger: (p) => p === 'web' ? fakeWeb : undefined })
    expect(buttonHandler).toBeDefined()

    // No registerRun, no sidecar approval. The bus has nothing for
    // this reqId — resolvePendingByReqId returns null → !info branch.
    await buttonHandler!({
      data: 'apv:orphan-req-xyz:y',
      threadId: 'thread-X',
      userId: 'u1',
      userDisplay: 'tester',
      messageId: 'msg-42',
      ack: async (t) => { acked = t },
    })

    expect(acked).toContain('过期')
    expect(edits.length).toBe(1)
    expect(edits[0].threadId).toBe('thread-X')
    expect(edits[0].messageId).toBe('msg-42')
    expect(edits[0].outcome.decision).toBe('expired')
  })

  it('the same orphan click before v1.2.113 produced 0 edits — confirm the new path always fires when installed', async () => {
    // Distinct from the test above: here the card lives in activeCards
    // (i.e. notifier did register it). The bus then auto-resolved and
    // ALSO cleared activeCards via onBusResolution. A subsequent click
    // still has to surface the expired state — this checks the path
    // doesn't regress to gating on activeCards.has.
    let buttonHandler: ((cb: ButtonCallback) => Promise<void>) | undefined
    const edits: Array<{ messageId: string; decision: ApprovalCardOutcome['decision'] }> = []
    const fakeWeb: MessengerAdapter = {
      name: 'web',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async () => {},
      onButtonCallback: (h) => { buttonHandler = h },
      editApprovalCard: async (_t, messageId, outcome) => {
        edits.push({ messageId, decision: outcome.decision })
      },
    }
    install({ resolveMessenger: (p) => p === 'web' ? fakeWeb : undefined })

    // Click twice — neither activeCards nor pendingById knows the reqId
    await buttonHandler!({
      data: 'apv:dead-req-1:y',
      threadId: 't', userId: 'u', messageId: 'm-1',
      ack: async () => {},
    })
    await buttonHandler!({
      data: 'apv:dead-req-1:n',
      threadId: 't', userId: 'u', messageId: 'm-1',
      ack: async () => {},
    })
    // Both clicks should produce edits — second click is the user's
    // "I'm tired of waiting" tap and needs to acknowledge too.
    expect(edits.length).toBe(2)
    expect(edits[0].decision).toBe('expired')
    expect(edits[1].decision).toBe('expired')
  })

  it('no-op (no throw) when messenger lacks editApprovalCard', async () => {
    let buttonHandler: ((cb: ButtonCallback) => Promise<void>) | undefined
    const fakeWeb: MessengerAdapter = {
      name: 'web',
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      sendMessage: async () => {},
      onButtonCallback: (h) => { buttonHandler = h },
      // editApprovalCard intentionally omitted
    }
    install({ resolveMessenger: (p) => p === 'web' ? fakeWeb : undefined })

    await expect(buttonHandler!({
      data: 'apv:no-edit-cap:y',
      threadId: 't', userId: 'u', messageId: 'm',
      ack: async () => {},
    })).resolves.toBeUndefined()
  })
})
