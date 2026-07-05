import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  KimiCodeAdapter,
  detectNewKimiSessionId,
  snapshotKimiSessionIds,
} from './index.js'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { AgentSendOpts } from '../../../core/types.js'
import { ApprovalBus, approvalBus, type RunContext } from '../../../core/approval-bus.js'

class KimiCodeAdapterTestable extends KimiCodeAdapter {
  exposeCommandName(): string {
    return this.commandName
  }

  exposeBuildArgs(prompt: string, opts: Record<string, unknown>): string[] {
    return this.buildArgs(prompt, opts as AgentSendOpts)
  }
  async exposePrepareCommand(prompt: string, opts: Record<string, unknown>) {
    return this.prepareCommand(prompt, opts as AgentSendOpts)
  }
  exposeExtractText(event: unknown): string {
    return this.extractText(event)
  }
  exposeInspectEvent(event: unknown, opts: Record<string, unknown>): void {
    this.inspectEvent(event, opts as AgentSendOpts)
  }
}

const adapter = new KimiCodeAdapterTestable()
const FULL_OPTS = {
  threadId: 'thread-A',
  platform: 'feishu',
  channelId: 'chan-1',
  userId: 'u1',
}

function uniqueSocketPath(): string {
  return join(tmpdir(), `agim-kimi-adapter-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

describe('KimiCodeAdapter — identity', () => {
  it('exposes name + aliases + kind', () => {
    expect(adapter.name).toBe('kimi-code')
    expect(adapter.aliases).toEqual(['kimi', 'km'])
    expect(adapter.kind).toBe('cli')
  })
})

describe('KimiCodeAdapter — command resolution', () => {
  it('finds the official installer binary under KIMI_CODE_HOME/bin/kimi', async () => {
    const oldHome = process.env.KIMI_CODE_HOME
    const dir = await mkdtemp(join(tmpdir(), 'agim-kimi-home-'))
    const bin = join(dir, 'bin', 'kimi')
    await mkdir(join(dir, 'bin'))
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(bin, 0o755)

    process.env.KIMI_CODE_HOME = dir
    try {
      expect(new KimiCodeAdapterTestable().exposeCommandName()).toBe(bin)
    } finally {
      if (oldHome === undefined) {
        delete process.env.KIMI_CODE_HOME
      } else {
        process.env.KIMI_CODE_HOME = oldHome
      }
    }
  })
})

describe('KimiCodeAdapter — buildArgs', () => {
  it('uses non-interactive stream-json mode', () => {
    const args = adapter.exposeBuildArgs('hello', {})
    expect(args).toEqual(['-p', 'hello', '--output-format', 'stream-json'])
  })

  it('passes session id when present', () => {
    const args = adapter.exposeBuildArgs('next', { agentSessionId: 'sess_abc' })
    expect(args).toContain('--session')
    expect(args[args.indexOf('--session') + 1]).toBe('sess_abc')
  })

  it('passes model when present', () => {
    const args = adapter.exposeBuildArgs('hi', { model: 'kimi-k2-thinking' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('kimi-k2-thinking')
  })

  it('does not append --plan because Kimi -p conflicts with --plan', () => {
    const args = adapter.exposeBuildArgs('design', { planMode: true })
    expect(args).not.toContain('--plan')
  })
})

describe('KimiCodeAdapter — approval-routed MCP', () => {
  let bus: ApprovalBus
  let adapter: KimiCodeAdapterTestable
  let kimiHome: string
  let workspaceRoot: string
  let oldKimiHome: string | undefined
  let oldWorkspaceRoot: string | undefined
  let originalGetSocketPath: () => string | null
  let originalRegisterRun: typeof approvalBus.registerRun
  let originalUnregisterRun: typeof approvalBus.unregisterRun
  let registered: Array<{ runId: string; ctx: RunContext }>
  let unregistered: string[]

  beforeEach(async () => {
    bus = new ApprovalBus({ approvalTimeoutMs: 500 })
    await bus.start(uniqueSocketPath())
    originalGetSocketPath = approvalBus.getSocketPath.bind(approvalBus)
    originalRegisterRun = approvalBus.registerRun.bind(approvalBus)
    originalUnregisterRun = approvalBus.unregisterRun.bind(approvalBus)
    registered = []
    unregistered = []
    approvalBus.getSocketPath = () => bus.getSocketPath()
    approvalBus.registerRun = (runId, ctx) => {
      registered.push({ runId, ctx })
      bus.registerRun(runId, ctx)
    }
    approvalBus.unregisterRun = (runId) => {
      unregistered.push(runId)
      bus.unregisterRun(runId)
    }

    kimiHome = await mkdtemp(join(tmpdir(), 'agim-kimi-home-'))
    workspaceRoot = await mkdtemp(join(tmpdir(), 'agim-kimi-workspaces-'))
    oldKimiHome = process.env.KIMI_CODE_HOME
    oldWorkspaceRoot = process.env.AGIM_WORKSPACES_ROOT
    process.env.KIMI_CODE_HOME = kimiHome
    process.env.AGIM_WORKSPACES_ROOT = workspaceRoot
    adapter = new KimiCodeAdapterTestable()
  })

  afterEach(async () => {
    await bus.stop()
    approvalBus.getSocketPath = originalGetSocketPath
    approvalBus.registerRun = originalRegisterRun
    approvalBus.unregisterRun = originalUnregisterRun
    if (oldKimiHome === undefined) {
      delete process.env.KIMI_CODE_HOME
    } else {
      process.env.KIMI_CODE_HOME = oldKimiHome
    }
    if (oldWorkspaceRoot === undefined) {
      delete process.env.AGIM_WORKSPACES_ROOT
    } else {
      process.env.AGIM_WORKSPACES_ROOT = oldWorkspaceRoot
    }
  })

  it('writes the per-run AGIM_RUN_ID into Kimi MCP config and registers cwd', async () => {
    const plan = await adapter.exposePrepareCommand('hi', FULL_OPTS)
    const parsed = JSON.parse(await readFile(join(kimiHome, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
    }
    const env = parsed.mcpServers.agim.env ?? {}
    const sockPath = bus.getSocketPath()
    const runId = env.AGIM_RUN_ID
    const planRunId = plan.extraEnv?.AGIM_RUN_ID
    if (!sockPath || !runId || !planRunId) throw new Error('missing MCP approval env')
    expect(env.AGIM_APPROVAL_SOCK).toBe(sockPath)
    expect(runId).toBe(planRunId)
    expect(runId.length).toBeGreaterThan(8)
    expect(registered[0].runId).toBe(runId)
    expect(registered[0].ctx.cwd).toBe(plan.cwd)
    expect(plan.cwd?.startsWith(workspaceRoot)).toBe(true)

    await plan.cleanup?.()
    expect(unregistered).toContain(runId)
  })

  it('rewrites Kimi MCP config with a fresh runId for each run', async () => {
    const first = await adapter.exposePrepareCommand('one', FULL_OPTS)
    const firstEnv = JSON.parse(await readFile(join(kimiHome, 'mcp.json'), 'utf8'))
      .mcpServers.agim.env as Record<string, string>
    await first.cleanup?.()

    const second = await adapter.exposePrepareCommand('two', FULL_OPTS)
    const secondEnv = JSON.parse(await readFile(join(kimiHome, 'mcp.json'), 'utf8'))
      .mcpServers.agim.env as Record<string, string>
    await second.cleanup?.()

    expect(firstEnv.AGIM_RUN_ID).not.toBe(secondEnv.AGIM_RUN_ID)
  })
})

describe('KimiCodeAdapter — extractText', () => {
  it('extracts assistant content arrays', () => {
    expect(adapter.exposeExtractText({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })).toBe('hello')
  })

  it('extracts assistant string content', () => {
    expect(adapter.exposeExtractText({
      role: 'assistant',
      content: 'plain text',
    })).toBe('plain text')
  })

  it('extracts delta text', () => {
    expect(adapter.exposeExtractText({
      type: 'delta',
      delta: { text: 'tok' },
    })).toBe('tok')
  })

  it('ignores tool calls and result events', () => {
    expect(adapter.exposeExtractText({ type: 'tool_call', name: 'x' })).toBe('')
    expect(adapter.exposeExtractText({ type: 'result', result: 'done' })).toBe('')
  })
})

describe('KimiCodeAdapter — inspectEvent', () => {
  it('captures session id from stream event', () => {
    let captured = ''
    adapter.exposeInspectEvent(
      { type: 'assistant', session_id: 'kimi-session-1' },
      { onAgentSessionId: (id: string) => { captured = id } },
    )
    expect(captured).toBe('kimi-session-1')
  })

  it('does not re-capture when caller already has a session id', () => {
    let captured = ''
    adapter.exposeInspectEvent(
      { type: 'assistant', session_id: 'kimi-session-2' },
      { agentSessionId: 'existing', onAgentSessionId: (id: string) => { captured = id } },
    )
    expect(captured).toBe('')
  })

  it('forwards token usage', () => {
    const deltas: Array<Record<string, number | undefined>> = []
    adapter.exposeInspectEvent(
      { type: 'result', usage: { input_tokens: 11, output_tokens: 22 } },
      { onUsage: (d: Record<string, number | undefined>) => { deltas.push(d) } },
    )
    expect(deltas).toEqual([{ tokensInput: 11, tokensOutput: 22 }])
  })
})

describe('Kimi Code session index helpers', () => {
  it('detects a newly appended session id from session_index.jsonl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agim-kimi-session-'))
    const file = join(dir, 'session_index.jsonl')
    await writeFile(file, `${JSON.stringify({ sessionId: 'old' })}\n`, 'utf8')
    const before = await snapshotKimiSessionIds(file)
    await writeFile(
      file,
      `${[
        JSON.stringify({ sessionId: 'old' }),
        '{bad-json',
        JSON.stringify({ sessionId: 'newer' }),
      ].join('\n')}\n`,
      'utf8',
    )
    expect(await detectNewKimiSessionId(before, file)).toBe('newer')
  })
})
