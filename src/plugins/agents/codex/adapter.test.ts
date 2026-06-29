// CodexAdapter — verify session-id capture, exec resume args, text extraction,
// and usage callbacks. Mirrors the opencode regression net for codex's
// `--json` event stream (codex 0.128).
//
// Reference event shapes (real codex output):
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi!"}}
//   {"type":"turn.completed","usage":{"input_tokens":13299,"cached_input_tokens":11648,"output_tokens":6,"reasoning_output_tokens":0}}

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ApprovalBus, approvalBus } from '../../../core/approval-bus.js'
import { CodexAdapter, _testInternals } from './index.js'
import type { AgentSendOpts } from '../../../core/types.js'

const { buildArgs, extractText, inspectEvent } = _testInternals

function uniqueSocketPath(): string {
  return join(tmpdir(), `agim-codex-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

const FULL_OPTS = {
  threadId: 'thread-A',
  platform: 'feishu',
  channelId: 'chan-1',
  userId: 'u1',
}

describe('CodexAdapter buildArgs', () => {
  it('starts a fresh session when no agentSessionId provided', () => {
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'hello', {})
    expect(args[0]).toBe('exec')
    expect(args).not.toContain('resume')
    expect(args).toContain('--json')
    expect(args[args.length - 1]).toBe('hello')
  })

  it('uses `exec resume <id>` when agentSessionId + agentSessionResume are set', () => {
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'hello', {
      agentSessionId: '019df376-0ec9-77c3-9d7d-1a15fd8cc9c9',
      agentSessionResume: true,
    })
    expect(args[0]).toBe('exec')
    expect(args[1]).toBe('resume')
    expect(args[2]).toBe('019df376-0ec9-77c3-9d7d-1a15fd8cc9c9')
    expect(args).toContain('--json')
    expect(args[args.length - 1]).toBe('hello')
  })

  it('does NOT use resume when agentSessionId is set without agentSessionResume', () => {
    // Defensive: agentSessionId without resume means "we know the id but
    // codex hasn't been told yet" — happens nowhere in practice but we want
    // a deterministic fallback rather than an undefined positional.
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'p', { agentSessionId: 'abc' })
    expect(args).not.toContain('resume')
    expect(args[0]).toBe('exec')
  })

  it('keeps --skip-git-repo-check on every call (post --full-auto removal)', () => {
    // --full-auto was dropped in favor of explicit `-s workspace-write`
    // (without auto-approval) — see codex/index.ts BASE_FLAGS comment.
    const adapter = new CodexAdapter()
    expect(buildArgs(adapter, 'p', {})).toContain('--skip-git-repo-check')
    expect(buildArgs(adapter, 'p', {})).not.toContain('--full-auto')
    expect(buildArgs(adapter, 'p', {
      agentSessionId: 'abc', agentSessionResume: true,
    })).toContain('--skip-git-repo-check')
  })

  it('passes --dangerously-bypass-approvals-and-sandbox by default so MCP tools work (non-interactive)', () => {
    // codex's MCP integration auto-cancels every tool call in exec --json
    // mode because no TUI is present to render approval prompts. The only
    // way to get MCP tools to actually run is the bypass flag. See file
    // header for the trade-off discussion.
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'p', {})
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
    // Bypass replaces the explicit -s flag — codex disables sandbox itself.
    expect(args).not.toContain('-s')
  })

  it('passes -s read-only when planMode is true (no bypass; plan runs are observation-only)', () => {
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'p', { planMode: true })
    expect(args).toContain('-s')
    expect(args).toContain('read-only')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('AGIM_CODEX_SAFE_MODE=1 opt-out: drops bypass, keeps -s workspace-write (loses MCP)', () => {
    const adapter = new CodexAdapter()
    const original = process.env.AGIM_CODEX_SAFE_MODE
    process.env.AGIM_CODEX_SAFE_MODE = '1'
    try {
      const args = buildArgs(adapter, 'p', {})
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(args).toContain('-s')
      expect(args).toContain('workspace-write')
    } finally {
      if (original === undefined) delete process.env.AGIM_CODEX_SAFE_MODE
      else process.env.AGIM_CODEX_SAFE_MODE = original
    }
  })

  it('AGIM_APPROVAL_DISABLED=1 also drops bypass — approval gating is off-by-design', () => {
    const adapter = new CodexAdapter()
    const original = process.env.AGIM_APPROVAL_DISABLED
    process.env.AGIM_APPROVAL_DISABLED = '1'
    try {
      const args = buildArgs(adapter, 'p', {})
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(args).toContain('-s')
    } finally {
      if (original === undefined) delete process.env.AGIM_APPROVAL_DISABLED
      else process.env.AGIM_APPROVAL_DISABLED = original
    }
  })

  it('on resume: no -s (codex 0.130 rejects it; session inherits sandbox), but bypass IS included', () => {
    // Regression: `codex exec resume` errors with "unexpected argument '-s'"
    // because the resume subcommand inherits the original session's sandbox
    // policy. The bypass flag is NOT a sandbox flag in resume's view, so it
    // stays — and we still need it for MCP tool calls on resume turns too.
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'p', {
      agentSessionId: 'abc', agentSessionResume: true,
    })
    expect(args).not.toContain('-s')
    expect(args).not.toContain('read-only')
    expect(args).not.toContain('workspace-write')
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('on resume + planMode: no -s, no bypass (plan resume is pure observation)', () => {
    const adapter = new CodexAdapter()
    const args = buildArgs(adapter, 'p', {
      agentSessionId: 'abc', agentSessionResume: true, planMode: true,
    })
    expect(args).not.toContain('-s')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })
})

describe('CodexAdapter extractText', () => {
  it('extracts text from item.completed agent_message', () => {
    const adapter = new CodexAdapter()
    const text = extractText(adapter, {
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'hello world' },
    })
    expect(text).toBe('hello world')
  })

  it('returns empty string for non-agent_message item types', () => {
    const adapter = new CodexAdapter()
    expect(extractText(adapter, {
      type: 'item.completed',
      item: { id: 'item_1', type: 'tool_call', text: 'should not surface' },
    })).toBe('')
  })

  it('returns empty for orchestration events (thread.started / turn.*)', () => {
    const adapter = new CodexAdapter()
    expect(extractText(adapter, { type: 'thread.started', thread_id: 'abc' })).toBe('')
    expect(extractText(adapter, { type: 'turn.started' })).toBe('')
    expect(extractText(adapter, { type: 'turn.completed', usage: { input_tokens: 10 } })).toBe('')
  })

  // Regression guard for the v0 adapter that hunted for {type:"message"} —
  // that event shape never fires in real codex 0.128 output.
  it('does NOT match the legacy {type:"message"} shape', () => {
    const adapter = new CodexAdapter()
    expect(extractText(adapter, {
      type: 'message',
      message: { content: [{ type: 'text', text: 'should-not-match' }] },
    })).toBe('')
  })
})

describe('CodexAdapter inspectEvent — session id capture', () => {
  it('forwards thread_id from thread.started via opts.onAgentSessionId', () => {
    const adapter = new CodexAdapter()
    const ids: string[] = []
    inspectEvent(adapter, { type: 'thread.started', thread_id: 'uuid-1' }, {
      onAgentSessionId: (id) => ids.push(id),
    })
    expect(ids).toEqual(['uuid-1'])
  })

  it('does not fire for events other than thread.started', () => {
    const adapter = new CodexAdapter()
    const ids: string[] = []
    const opts: AgentSendOpts = { onAgentSessionId: (id) => ids.push(id) }
    inspectEvent(adapter, { type: 'turn.started' }, opts)
    inspectEvent(adapter, {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'hi' },
    }, opts)
    expect(ids.length).toBe(0)
  })

  it('does nothing when callback is absent', () => {
    const adapter = new CodexAdapter()
    inspectEvent(adapter, { type: 'thread.started', thread_id: 'x' }, {})
    // Absence of throw is the assertion.
    expect(true).toBe(true)
  })

  it('survives a callback that throws', () => {
    const adapter = new CodexAdapter()
    inspectEvent(adapter, { type: 'thread.started', thread_id: 'x' }, {
      onAgentSessionId: () => { throw new Error('boom') },
    })
    expect(true).toBe(true)
  })
})

describe('CodexAdapter inspectEvent — usage capture', () => {
  it('forwards input/output tokens from turn.completed.usage', () => {
    const adapter = new CodexAdapter()
    const deltas: Array<{ costUsd?: number; tokensInput?: number; tokensOutput?: number }> = []
    inspectEvent(adapter, {
      type: 'turn.completed',
      usage: {
        input_tokens: 13299,
        cached_input_tokens: 11648,
        output_tokens: 6,
        reasoning_output_tokens: 0,
      },
    }, { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(1)
    expect(deltas[0].tokensInput).toBe(13299)
    expect(deltas[0].tokensOutput).toBe(6)
    // codex doesn't surface cost — should remain undefined.
    expect(deltas[0].costUsd).toBeUndefined()
  })

  it('does NOT fire onUsage for non-turn.completed events', () => {
    const adapter = new CodexAdapter()
    const deltas: unknown[] = []
    inspectEvent(adapter, { type: 'turn.started' }, { onUsage: (d) => deltas.push(d) })
    inspectEvent(adapter, {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'hi' },
    }, { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(0)
  })

  it('skips onUsage when turn.completed carries no usage block', () => {
    const adapter = new CodexAdapter()
    const deltas: unknown[] = []
    inspectEvent(adapter, { type: 'turn.completed' }, { onUsage: (d) => deltas.push(d) })
    expect(deltas.length).toBe(0)
  })
})

describe('CodexAdapter prepareCommand — fallback paths', () => {
  let adapter: CodexAdapter

  beforeEach(() => {
    adapter = new CodexAdapter()
    delete process.env.AGIM_APPROVAL_DISABLED
  })

  afterEach(() => {
    delete process.env.AGIM_APPROVAL_DISABLED
  })

  it('does not pin cwd for non-IM calls (no threadId/platform)', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'p', {})
    expect(plan.cwd).toBeUndefined()
  })

  it('pins cwd to ~/.agim-workspaces/codex when threadId+platform present', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'p', FULL_OPTS)
    expect(plan.cwd).toBeDefined()
    expect(plan.cwd?.endsWith('/codex')).toBe(true)
  })

  it('omits MCP -c flags when bus is not started', async () => {
    expect(approvalBus.getSocketPath()).toBeNull()
    const plan = await _testInternals.prepareCommand(adapter, 'p', FULL_OPTS)
    expect(plan.args).not.toContain('-c')
    expect(plan.args[0]).toBe('exec')
    expect(plan.cleanup).toBeUndefined()
  })

  it('omits MCP -c flags when AGIM_APPROVAL_DISABLED=1', async () => {
    process.env.AGIM_APPROVAL_DISABLED = '1'
    const plan = await _testInternals.prepareCommand(adapter, 'p', FULL_OPTS)
    expect(plan.args).not.toContain('-c')
    expect(plan.args[0]).toBe('exec')
    expect(plan.cleanup).toBeUndefined()
  })

  it('omits MCP -c flags for non-IM calls (no threadId)', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'p', { model: 'gpt-5' })
    expect(plan.args).not.toContain('-c')
    expect(plan.args[0]).toBe('exec')
    expect(plan.cleanup).toBeUndefined()
  })
})

describe('CodexAdapter prepareCommand — MCP-routed', () => {
  // Mirrors the claude-code adapter pattern: stand up a real ApprovalBus,
  // monkey-patch the singleton to delegate to it, exercise the adapter, then
  // tear down. Real bus + real socket so registerRun side-effects (and
  // cleanup) are observable.

  let bus: ApprovalBus
  let adapter: CodexAdapter
  let registered: string[]
  let unregistered: string[]
  let originalGetSocketPath: () => string | null
  let originalRegisterRun: typeof approvalBus.registerRun
  let originalUnregisterRun: typeof approvalBus.unregisterRun

  beforeEach(async () => {
    bus = new ApprovalBus({ approvalTimeoutMs: 500 })
    await bus.start(uniqueSocketPath())
    registered = []
    unregistered = []
    originalGetSocketPath = approvalBus.getSocketPath.bind(approvalBus)
    originalRegisterRun = approvalBus.registerRun.bind(approvalBus)
    originalUnregisterRun = approvalBus.unregisterRun.bind(approvalBus)
    approvalBus.getSocketPath = () => bus.getSocketPath()
    approvalBus.registerRun = (runId, ctx) => {
      registered.push(runId)
      bus.registerRun(runId, ctx)
    }
    approvalBus.unregisterRun = (runId) => {
      unregistered.push(runId)
      bus.unregisterRun(runId)
    }

    adapter = new CodexAdapter()
  })

  afterEach(async () => {
    await bus.stop()
    approvalBus.getSocketPath = originalGetSocketPath
    approvalBus.registerRun = originalRegisterRun
    approvalBus.unregisterRun = originalUnregisterRun
  })

  it('prepends three MCP -c pairs before the exec subcommand', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    // -c pairs must precede `exec` (codex clap requires global flags
    // before the subcommand). The first 6 entries are MCP -c pairs.
    expect(plan.args[0]).toBe('-c')
    expect(plan.args[1].startsWith('mcp_servers.agim.command=')).toBe(true)
    expect(plan.args[2]).toBe('-c')
    expect(plan.args[3].startsWith('mcp_servers.agim.args=')).toBe(true)
    expect(plan.args[4]).toBe('-c')
    expect(plan.args[5].startsWith('mcp_servers.agim.env=')).toBe(true)
    expect(plan.args[6]).toBe('exec')
    // Prompt is still the trailing positional.
    expect(plan.args[plan.args.length - 1]).toBe('hi')
  })

  it('embeds the live socket path + a fresh UUID runId in the env -c arg', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    const envArg = plan.args.find((a) => a.startsWith('mcp_servers.agim.env=')) as string
    expect(envArg).toContain(`AGIM_APPROVAL_SOCK=${JSON.stringify(bus.getSocketPath() as string)}`)
    // runId is a UUID; assert minimally — has the expected shape.
    const m = envArg.match(/AGIM_RUN_ID="([^"]+)"/)
    expect(m).toBeTruthy()
    expect(m![1].length).toBeGreaterThan(8)
  })

  it('cleanup unregisters the run from the bus', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    expect(plan.cleanup).toBeDefined()
    const envArg = plan.args.find((a) => a.startsWith('mcp_servers.agim.env=')) as string
    const runId = envArg.match(/AGIM_RUN_ID="([^"]+)"/)![1]
    expect(registered).toContain(runId)
    expect(unregistered).not.toContain(runId)
    await plan.cleanup?.()
    expect(unregistered).toContain(runId)
  })

  it('still pins cwd alongside MCP routing', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    expect(plan.cwd?.endsWith('/codex')).toBe(true)
  })

  it('preserves planMode → -s read-only when MCP-routed (no bypass)', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', { ...FULL_OPTS, planMode: true })
    const sIdx = plan.args.indexOf('-s')
    expect(plan.args[sIdx + 1]).toBe('read-only')
    expect(plan.args).not.toContain('workspace-write')
    // Plan runs are observation-only — no bypass even when MCP-routed.
    expect(plan.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('default (non-plan) MCP-routed runs include the bypass flag so MCP tools execute', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', FULL_OPTS)
    expect(plan.args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('preserves exec resume <id> structure when MCP-routed', async () => {
    const plan = await _testInternals.prepareCommand(adapter, 'hi', {
      ...FULL_OPTS, agentSessionId: 'abc-uuid', agentSessionResume: true,
    })
    // MCP -c pairs (6) come first, then exec resume <id> …
    expect(plan.args[6]).toBe('exec')
    expect(plan.args[7]).toBe('resume')
    expect(plan.args[8]).toBe('abc-uuid')
  })

  it('each prepareCommand call produces a distinct runId (concurrent safety)', async () => {
    const [a, b] = await Promise.all([
      _testInternals.prepareCommand(adapter, 'p1', FULL_OPTS),
      _testInternals.prepareCommand(adapter, 'p2', FULL_OPTS),
    ])
    const ridA = (a.args.find((x) => x.startsWith('mcp_servers.agim.env=')) as string)
      .match(/AGIM_RUN_ID="([^"]+)"/)![1]
    const ridB = (b.args.find((x) => x.startsWith('mcp_servers.agim.env=')) as string)
      .match(/AGIM_RUN_ID="([^"]+)"/)![1]
    expect(ridA).not.toBe(ridB)
    await a.cleanup?.()
    await b.cleanup?.()
  })
})
