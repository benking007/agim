// ClaudeCodeAdapter — verify prepareCommand picks the right path under each
// degradation condition (env disable / no IM context / bus down) and that the
// approval-routed plan writes a sensible mcp-config + cleans it up.
//
// Concurrency note: this rewrite (after we found the singleton race that
// caused mcp.json to be deleted out from under a second concurrent claude
// run) explicitly tests that two prepareCommand() calls overlapping each
// other still produce two distinct configs with no shared state.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ApprovalBus, approvalBus, type RunContext } from '../../../core/approval-bus.js'
import { ClaudeCodeAdapter, _testInternals } from './index.js'
import type { SpawnPlan } from '../../../core/agent-base.js'

function uniqueSocketPath(): string {
  return join(tmpdir(), `agim-adapter-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

const FULL_OPTS = {
  threadId: 'thread-A',
  platform: 'feishu',
  channelId: 'chan-1',
  userId: 'u1',
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

describe('ClaudeCodeAdapter prepareCommand — fallback paths', () => {
  let adapter: ClaudeCodeAdapter

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter()
    delete process.env.AGIM_APPROVAL_DISABLED
    delete process.env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS
  })

  afterEach(() => {
    delete process.env.AGIM_APPROVAL_DISABLED
    delete process.env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS
  })

  it('falls back to dontAsk when AGIM_APPROVAL_DISABLED=1', async () => {
    process.env.AGIM_APPROVAL_DISABLED = '1'
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(plan.args).not.toContain('--permission-prompt-tool')
    expect(plan.args).not.toContain('--mcp-config')
    expect(plan.cleanup).toBeUndefined()
  })

  it('falls back to dontAsk when no IM context (web/scheduler call)', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', { model: 'sonnet' })
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(plan.cleanup).toBeUndefined()
  })

  it('falls back to dontAsk when bus is not started', async () => {
    expect(approvalBus.getSocketPath()).toBeNull()
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(plan.cleanup).toBeUndefined()
  })

  it('uses --permission-mode plan + skips mcp-config when planMode=true', async () => {
    // planMode short-circuits the approval-bus pipeline regardless of IM
    // context — plan is read-only so there is nothing for the bus to gate.
    const plan = await _testInternals.prepareCommand(adapter, 'sketch', { ...FULL_OPTS, planMode: true })
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(plan.args).not.toContain('--mcp-config')
    expect(plan.args).not.toContain('--permission-prompt-tool')
    expect(plan.cleanup).toBeUndefined()
    expect(plan.args[plan.args.length - 1]).toBe('sketch')
  })

  it('buildArgs uses plan when planMode is set, dontAsk otherwise', () => {
    const plain = _testInternals.buildArgs(adapter, 'p', {})
    expect(plain[plain.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    const planning = _testInternals.buildArgs(adapter, 'p', { planMode: true })
    expect(planning[planning.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  it('AGIM_DANGEROUSLY_SKIP_PERMISSIONS=1 emits --dangerously-skip-permissions and skips approval routing', async () => {
    process.env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS = '1'
    const plan = await _testInternals.prepareCommand(adapter, 'hello', FULL_OPTS)
    expect(plan.args).toContain('--dangerously-skip-permissions')
    // No approval-bus wiring, no mcp-config tmpdir, no dontAsk fallback.
    expect(plan.args).not.toContain('--permission-mode')
    expect(plan.args).not.toContain('--permission-prompt-tool')
    expect(plan.args).not.toContain('--mcp-config')
    expect(plan.cleanup).toBeUndefined()
    // Prompt is still the last arg.
    expect(plan.args[plan.args.length - 1]).toBe('hello')
  })

  it('skip-permissions still loses to planMode (read-only wins over bypass)', async () => {
    // Operator may have flipped the global "skip permissions" toggle, but
    // an individual plan-mode call should still be read-only — there is
    // nothing to skip when nothing mutates.
    process.env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS = '1'
    const plan = await _testInternals.prepareCommand(adapter, 'sketch', { ...FULL_OPTS, planMode: true })
    expect(plan.args).not.toContain('--dangerously-skip-permissions')
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  it('skip-permissions takes precedence over AGIM_APPROVAL_DISABLED', async () => {
    process.env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS = '1'
    process.env.AGIM_APPROVAL_DISABLED = '1'
    const plan = await _testInternals.prepareCommand(adapter, 'hello', FULL_OPTS)
    expect(plan.args).toContain('--dangerously-skip-permissions')
    expect(plan.args).not.toContain('--permission-mode')
  })
})

describe('ClaudeCodeAdapter prepareCommand — approval-routed', () => {
  let bus: ApprovalBus
  let adapter: ClaudeCodeAdapter
  let registered: Array<{ runId: string; ctx: RunContext }>
  let originalGetSocketPath: () => string | null
  let originalRegisterRun: typeof approvalBus.registerRun
  let originalUnregisterRun: typeof approvalBus.unregisterRun

  beforeEach(async () => {
    bus = new ApprovalBus({ approvalTimeoutMs: 500 })
    await bus.start(uniqueSocketPath())
    registered = []
    originalGetSocketPath = approvalBus.getSocketPath.bind(approvalBus)
    originalRegisterRun = approvalBus.registerRun.bind(approvalBus)
    originalUnregisterRun = approvalBus.unregisterRun.bind(approvalBus)
    approvalBus.getSocketPath = () => bus.getSocketPath()
    approvalBus.registerRun = (runId, ctx) => {
      registered.push({ runId, ctx })
      bus.registerRun(runId, ctx)
    }
    approvalBus.unregisterRun = bus.unregisterRun.bind(bus)

    adapter = new ClaudeCodeAdapter()
  })

  afterEach(async () => {
    await bus.stop()
    approvalBus.getSocketPath = originalGetSocketPath
    approvalBus.registerRun = originalRegisterRun
    approvalBus.unregisterRun = originalUnregisterRun
  })

  it('writes a valid mcp-config and emits approval-mode args', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    expect(plan.cleanup).toBeDefined()

    const cfgIdx = plan.args.indexOf('--mcp-config')
    expect(cfgIdx).toBeGreaterThanOrEqual(0)
    const configPath = plan.args[cfgIdx + 1]
    expect(await fileExists(configPath)).toBe(true)

    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.mcpServers.agim).toBeDefined()
    expect(parsed.mcpServers.agim.command).toBe(process.execPath)
    expect(parsed.mcpServers.agim.args[0]).toMatch(/mcp-approval-server\.js$/)
    expect(parsed.mcpServers.agim.env.AGIM_APPROVAL_SOCK).toBe(bus.getSocketPath())
    expect(typeof parsed.mcpServers.agim.env.AGIM_RUN_ID).toBe('string')
    expect(parsed.mcpServers.agim.env.AGIM_RUN_ID.length).toBeGreaterThan(0)

    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('default')
    expect(plan.args[plan.args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__agim__request')
    expect(plan.args[plan.args.length - 1]).toBe('hi')
    expect(registered[0].ctx.cwd).toBe(plan.cwd)

    // mcp-config must come BEFORE the next `-X` flag so its variadic
    // <configs...> doesn't swallow the prompt as a second config path.
    expect(cfgIdx).toBe(0)
    expect(plan.args[cfgIdx + 2].startsWith('-')).toBe(true)

    await plan.cleanup?.()
  })

  it('cleanup unregisters run and removes config tmpdir', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    const configPath = plan.args[plan.args.indexOf('--mcp-config') + 1]
    expect(await fileExists(configPath)).toBe(true)

    await plan.cleanup?.()
    expect(await fileExists(configPath)).toBe(false)
  })

  it('AGIM_APPROVAL_DISABLED still wins even when bus is up', async () => {
    process.env.AGIM_APPROVAL_DISABLED = '1'
    try {
      const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
      expect(plan.cleanup).toBeUndefined()
      expect(plan.args).not.toContain('--mcp-config')
      expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    } finally {
      delete process.env.AGIM_APPROVAL_DISABLED
    }
  })

  it('AGIM_DANGEROUSLY_SKIP_PERMISSIONS=1 wins even when bus is up and IM ctx is present', async () => {
    process.env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS = '1'
    try {
      const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
      expect(plan.args).toContain('--dangerously-skip-permissions')
      expect(plan.args).not.toContain('--mcp-config')
      expect(plan.args).not.toContain('--permission-prompt-tool')
      expect(plan.cleanup).toBeUndefined()
    } finally {
      delete process.env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS
    }
  })

  it('two prepareCommand calls return INDEPENDENT configs (concurrency safety)', async () => {
    // Fire them in parallel, with their awaits genuinely interleaving.
    const [planA, planB] = await Promise.all([
      _testInternals.prepareCommand(adapter, 'A', FULL_OPTS),
      _testInternals.prepareCommand(adapter, 'B', FULL_OPTS),
    ])

    const cfgA = planA.args[planA.args.indexOf('--mcp-config') + 1]
    const cfgB = planB.args[planB.args.indexOf('--mcp-config') + 1]
    expect(cfgA).not.toBe(cfgB)

    const rawA = JSON.parse(await readFile(cfgA, 'utf8'))
    const rawB = JSON.parse(await readFile(cfgB, 'utf8'))
    expect(rawA.mcpServers.agim.env.AGIM_RUN_ID)
      .not.toBe(rawB.mcpServers.agim.env.AGIM_RUN_ID)

    // Cleaning up A must NOT remove B's config.
    await planA.cleanup?.()
    expect(await fileExists(cfgA)).toBe(false)
    expect(await fileExists(cfgB)).toBe(true)

    await planB.cleanup?.()
    expect(await fileExists(cfgB)).toBe(false)
  })

  it('cleanup is idempotent (calling twice is safe)', async () => {
    const plan: SpawnPlan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    await plan.cleanup?.()
    // Should not throw on the second call
    await plan.cleanup?.()
  })

  // Regression for ADR 0005: every fallback return inside prepareCommand must
  // carry cwd. An earlier version dropped it on the mkdtemp-failure branch,
  // silently demoting that one call back to agim's "/" cwd and leaking
  // memory across IM and terminal Claude.
  it('mkdtemp failure still propagates cwd (ADR 0005)', async () => {
    process.env.AGIM_CLAUDE_CODE_CWD = '/tmp/agim-cwd-regression-xyz'
    const origTmp = process.env.TMPDIR
    process.env.TMPDIR = '/proc/agim-bogus-no-such-dir/xyz'
    try {
      const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
      expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
      expect(plan.args).not.toContain('--mcp-config')
      expect(plan.cleanup).toBeUndefined()
      expect(plan.cwd).toBe('/tmp/agim-cwd-regression-xyz')
    } finally {
      if (origTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = origTmp
      delete process.env.AGIM_CLAUDE_CODE_CWD
    }
  })
})

describe('ClaudeCodeAdapter — partial-message token streaming (F:streaming)', () => {
  let adapter: ClaudeCodeAdapter
  beforeEach(() => { adapter = new ClaudeCodeAdapter(); delete process.env.AGIM_CLAUDE_PARTIAL_STREAM })
  afterEach(() => { delete process.env.AGIM_CLAUDE_PARTIAL_STREAM })

  const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

  it('default ON: buildArgs includes --include-partial-messages', () => {
    const args = _testInternals.buildArgs(adapter, 'p', {})
    expect(args).toContain('--include-partial-messages')
  })

  it('env=0: buildArgs omits the flag (block-streaming fallback)', () => {
    process.env.AGIM_CLAUDE_PARTIAL_STREAM = '0'
    const args = _testInternals.buildArgs(adapter, 'p', {})
    expect(args).not.toContain('--include-partial-messages')
  })

  it('extractText returns text_delta increments and skips the consolidated assistant block', () => {
    expect(_testInternals.extractText(adapter, delta('Hel'))).toBe('Hel')
    expect(_testInternals.extractText(adapter, delta('lo'))).toBe('lo')
    // consolidated block is skipped while partial streaming is on (no doubling)
    expect(_testInternals.extractText(adapter, assistant('Hello'))).toBe('')
  })

  it('extractText ignores non-text deltas (thinking / input_json / block markers)', () => {
    const thinking = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', text: 'hmm' } } }
    const start = { type: 'stream_event', event: { type: 'content_block_start' } }
    expect(_testInternals.extractText(adapter, thinking)).toBe('')
    expect(_testInternals.extractText(adapter, start)).toBe('')
  })

  it('env=0: extractText falls back to the assistant block (legacy behavior)', () => {
    process.env.AGIM_CLAUDE_PARTIAL_STREAM = '0'
    expect(_testInternals.extractText(adapter, assistant('Hello'))).toBe('Hello')
  })
})
