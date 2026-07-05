import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AgentSendOpts } from '../../../core/types.js'
import { ApprovalBus, approvalBus, type RunContext } from '../../../core/approval-bus.js'
import { CopilotAdapter } from './index.js'

class CopilotAdapterTestable extends CopilotAdapter {
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

const adapter = new CopilotAdapterTestable()
const FULL_OPTS = {
  threadId: 'thread-A',
  platform: 'feishu',
  channelId: 'chan-1',
  userId: 'u1',
}

function uniqueSocketPath(): string {
  return join(tmpdir(), `agim-copilot-adapter-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) {
    old[key] = process.env[key]
    const value = vars[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    return fn()
  } finally {
    for (const key of Object.keys(vars)) {
      const value = old[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('CopilotAdapter — identity', () => {
  it('exposes name + aliases + kind', () => {
    expect(adapter.name).toBe('copilot')
    expect(adapter.aliases).toEqual(['co', 'gh-copilot', 'github-copilot'])
    expect(adapter.kind).toBe('cli')
  })
})

describe('CopilotAdapter — command resolution', () => {
  it('honors AGIM_COPILOT_BIN', () => {
    withEnv({ AGIM_COPILOT_BIN: '/tmp/copilot-custom' }, () => {
      expect(new CopilotAdapterTestable().exposeCommandName()).toBe('/tmp/copilot-custom')
    })
  })

  it('finds copilot in HOME/.local/bin', async () => {
    const oldHome = process.env.HOME
    const dir = await mkdtemp(join(tmpdir(), 'agim-copilot-home-'))
    const localBin = join(dir, '.local', 'bin')
    const bin = join(localBin, 'copilot')
    await mkdir(localBin, { recursive: true })
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(bin, 0o755)

    process.env.HOME = dir
    try {
      expect(new CopilotAdapterTestable().exposeCommandName()).toBe(bin)
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = oldHome
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('CopilotAdapter — buildArgs', () => {
  it('uses programmatic silent text mode', () => {
    const args = adapter.exposeBuildArgs('hello', {})
    for (const value of ['-p', 'hello', '-s', '--output-format', 'text', '--no-ask-user', '--no-color', '--no-auto-update']) {
      expect(args).toContain(value)
    }
  })

  it('passes session id and model', () => {
    const args = adapter.exposeBuildArgs('next', {
      agentSessionId: '4b360fd7-d9be-4998-bc95-eb97afc7a58e',
      model: 'gpt-5-mini',
    })
    expect(args).toContain('--session-id')
    expect(args[args.indexOf('--session-id') + 1]).toBe('4b360fd7-d9be-4998-bc95-eb97afc7a58e')
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5-mini')
  })

  it('denies native mutation tools unless safe mode opts out of automation', () => {
    withEnv({ AGIM_COPILOT_SAFE_MODE: undefined }, () => {
      const args = adapter.exposeBuildArgs('hi', {})
      expect(args).toContain('--allow-all-tools')
      expect(args).toContain('--allow-all-urls')
      expect(args).toContain('--deny-tool')
      expect(args).toContain('bash')
      expect(args).toContain('shell')
      expect(args).toContain('terminal')
      expect(args).toContain('exec')
      expect(args).toContain('write')
      expect(args).toContain('write_file')
      expect(args).toContain('edit')
      expect(args).toContain('apply_patch')
      expect(args).toContain('delete')
    })
    withEnv({ AGIM_COPILOT_SAFE_MODE: '1' }, () => {
      const args = adapter.exposeBuildArgs('hi', {})
      expect(args).not.toContain('--allow-all-tools')
      expect(args).not.toContain('--deny-tool')
    })
  })
})

describe('CopilotAdapter — approval-routed MCP', () => {
  let bus: ApprovalBus
  let adapter: CopilotAdapterTestable
  let workspaceRoot: string
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
    workspaceRoot = await mkdtemp(join(tmpdir(), 'agim-copilot-workspaces-'))
    oldWorkspaceRoot = process.env.AGIM_WORKSPACES_ROOT
    process.env.AGIM_WORKSPACES_ROOT = workspaceRoot
    adapter = new CopilotAdapterTestable()
  })

  afterEach(async () => {
    await bus.stop()
    approvalBus.getSocketPath = originalGetSocketPath
    approvalBus.registerRun = originalRegisterRun
    approvalBus.unregisterRun = originalUnregisterRun
    if (oldWorkspaceRoot === undefined) {
      delete process.env.AGIM_WORKSPACES_ROOT
    } else {
      process.env.AGIM_WORKSPACES_ROOT = oldWorkspaceRoot
    }
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('preallocates session id, writes per-run MCP config, and registers cwd', async () => {
    let capturedSession = ''
    const plan = await adapter.exposePrepareCommand('hi', {
      ...FULL_OPTS,
      onAgentSessionId: (id: string) => { capturedSession = id },
    })
    const sessionId = plan.args[plan.args.indexOf('--session-id') + 1]
    if (!sessionId) throw new Error('missing session id')
    expect(capturedSession).toBe(sessionId)
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
    const cwd = plan.cwd
    if (!cwd) throw new Error('missing cwd')
    expect(cwd).toBe(join(workspaceRoot, 'copilot'))
    expect(plan.args).toContain('--add-dir')
    const addDir = plan.args[plan.args.indexOf('--add-dir') + 1]
    if (!addDir) throw new Error('missing add-dir path')
    expect(addDir).toBe(cwd)
    expect(plan.args).toContain('--additional-mcp-config')
    expect(plan.args).toContain('--allow-tool')
    expect(plan.args[plan.args.indexOf('--allow-tool') + 1]).toBe('agim')

    const configArg = plan.args[plan.args.indexOf('--additional-mcp-config') + 1]
    if (!configArg) throw new Error('missing mcp config path')
    expect(configArg.startsWith('@')).toBe(true)
    const configPath = configArg.slice(1)
    const cfg = JSON.parse(await readFile(configPath, 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
    }
    const agim = cfg.mcpServers?.agim
    const sockPath = bus.getSocketPath()
    if (!sockPath) throw new Error('missing socket path')
    const runId = plan.extraEnv?.AGIM_RUN_ID
    if (!runId) throw new Error('missing run id')
    const firstRegistered = registered[0]
    if (!firstRegistered) throw new Error('missing registered run')
    expect(agim?.command).toBe(process.execPath)
    expect(agim?.args?.[0]?.endsWith('mcp-approval-server.js')).toBe(true)
    expect(agim?.env?.AGIM_APPROVAL_SOCK).toBe(sockPath)
    expect(agim?.env?.AGIM_RUN_ID).toBe(runId)
    expect(firstRegistered.runId).toBe(runId)
    expect(firstRegistered.ctx.cwd).toBe(cwd)

    await plan.cleanup?.()
    expect(unregistered).toContain(runId)
    const afterCleanup = await readFile(configPath, 'utf8').then(() => true).catch(() => false)
    expect(afterCleanup).toBe(false)
  })

  it('reuses existing session id instead of preallocating', async () => {
    let called = false
    const plan = await adapter.exposePrepareCommand('hi', {
      ...FULL_OPTS,
      agentSessionId: '4b360fd7-d9be-4998-bc95-eb97afc7a58e',
      onAgentSessionId: () => { called = true },
    })
    expect(plan.args[plan.args.indexOf('--session-id') + 1]).toBe('4b360fd7-d9be-4998-bc95-eb97afc7a58e')
    expect(called).toBe(false)
    await plan.cleanup?.()
  })
})

describe('CopilotAdapter — extractText', () => {
  it('extracts assistant content arrays', () => {
    expect(adapter.exposeExtractText({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })).toBe('hello')
  })

  it('extracts delta text and result fallback', () => {
    expect(adapter.exposeExtractText({ type: 'delta', delta: { text: 'chunk' } })).toBe('chunk')
    expect(adapter.exposeExtractText({ type: 'assistant_delta', delta: 'raw' })).toBe('raw')
    expect(adapter.exposeExtractText({ type: 'result', result: 'done' })).toBe('done')
  })

  it('ignores synthetic error events so handleError can format them', () => {
    expect(adapter.exposeExtractText({ type: 'error', error: 'boom' })).toBe('')
  })
})

describe('CopilotAdapter — inspectEvent', () => {
  it('reports usage deltas', () => {
    let input = 0
    let output = 0
    adapter.exposeInspectEvent({
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
        output_tokens: 5,
      },
    }, {
      onUsage: (delta: { tokensInput?: number; tokensOutput?: number }) => {
        input = delta.tokensInput ?? 0
        output = delta.tokensOutput ?? 0
      },
    })
    expect(input).toBe(15)
    expect(output).toBe(5)
  })
})
