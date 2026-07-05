import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AgentSendOpts } from '../../../core/types.js'
import { ApprovalBus, approvalBus, type RunContext } from '../../../core/approval-bus.js'
import { AntigravityAdapter } from './index.js'

class AntigravityAdapterTestable extends AntigravityAdapter {
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

  exposeHandleError(code: number, stderr: string, errorMessage: string): string | null {
    return this.handleError(code, stderr, errorMessage)
  }

  exposeEmptyOutputMessage(stderr: string, errorMessage: string): string | null {
    return this.emptyOutputMessage(stderr, errorMessage)
  }
}

const adapter = new AntigravityAdapterTestable()
const FULL_OPTS = {
  threadId: 'thread-A',
  platform: 'feishu',
  channelId: 'chan-1',
  userId: 'u1',
}

function uniqueSocketPath(): string {
  return join(tmpdir(), `agim-antigravity-adapter-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
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

describe('AntigravityAdapter — identity', () => {
  it('exposes name + aliases + kind', () => {
    expect(adapter.name).toBe('antigravity')
    expect(adapter.aliases).toEqual(['agy', 'gemini', 'ag'])
    expect(adapter.kind).toBe('cli')
  })
})

describe('AntigravityAdapter — command resolution', () => {
  it('honors AGIM_ANTIGRAVITY_BIN', () => {
    withEnv({ AGIM_ANTIGRAVITY_BIN: '/tmp/agy-custom' }, () => {
      expect(new AntigravityAdapterTestable().exposeCommandName()).toBe('/tmp/agy-custom')
    })
  })

  it('finds agy in HOME/.local/bin', async () => {
    const oldHome = process.env.HOME
    const dir = await mkdtemp(join(tmpdir(), 'agim-antigravity-home-'))
    const localBin = join(dir, '.local', 'bin')
    const bin = join(localBin, 'agy')
    await mkdir(localBin, { recursive: true })
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(bin, 0o755)

    process.env.HOME = dir
    try {
      expect(new AntigravityAdapterTestable().exposeCommandName()).toBe(bin)
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = oldHome
      }
    }
  })
})

describe('AntigravityAdapter — buildArgs', () => {
  it('uses print mode for fresh runs', () => {
    expect(adapter.exposeBuildArgs('hello', {})).toEqual(['--print', 'hello'])
  })

  it('passes conversation id when resuming', () => {
    expect(adapter.exposeBuildArgs('next', { agentSessionId: 'agy-conv' }))
      .toEqual(['--print', '--conversation', 'agy-conv', 'next'])
  })
})

describe('AntigravityAdapter — approval-routed MCP', () => {
  let bus: ApprovalBus
  let adapter: AntigravityAdapterTestable
  let workspaceRoot: string
  let mcpConfigPath: string
  let oldWorkspaceRoot: string | undefined
  let oldMcpConfigPath: string | undefined
  let oldHome: string | undefined
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

    workspaceRoot = await mkdtemp(join(tmpdir(), 'agim-antigravity-workspaces-'))
    const home = await mkdtemp(join(tmpdir(), 'agim-antigravity-home-'))
    mcpConfigPath = join(home, '.gemini', 'config', 'mcp_config.json')
    oldWorkspaceRoot = process.env.AGIM_WORKSPACES_ROOT
    oldMcpConfigPath = process.env.AGIM_ANTIGRAVITY_MCP_CONFIG
    oldHome = process.env.HOME
    process.env.AGIM_WORKSPACES_ROOT = workspaceRoot
    process.env.AGIM_ANTIGRAVITY_MCP_CONFIG = mcpConfigPath
    process.env.HOME = home
    adapter = new AntigravityAdapterTestable()
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
    if (oldMcpConfigPath === undefined) {
      delete process.env.AGIM_ANTIGRAVITY_MCP_CONFIG
    } else {
      process.env.AGIM_ANTIGRAVITY_MCP_CONFIG = oldMcpConfigPath
    }
    if (oldHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = oldHome
    }
  })

  it('writes agim MCP config, registers run context, and scopes cwd', async () => {
    const plan = await adapter.exposePrepareCommand('hi', FULL_OPTS)
    const cfg = JSON.parse(await readFile(mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
    }
    const agim = cfg.mcpServers.agim
    const sockPath = bus.getSocketPath()
    const runId = plan.extraEnv?.AGIM_RUN_ID
    if (!sockPath || !runId) throw new Error('missing MCP approval env')
    const cwd = plan.cwd
    if (!cwd) throw new Error('missing cwd')

    expect(plan.args.slice(0, 3)).toEqual(['--add-dir', cwd, '--print'])
    expect(plan.args.at(-1)).toBe('hi')
    expect(cwd).toBe(join(workspaceRoot, 'antigravity'))
    expect(agim.command).toBe(process.execPath)
    expect(agim.args?.[0]?.endsWith('mcp-approval-server.js')).toBe(true)
    expect(agim.env?.AGIM_APPROVAL_SOCK).toBe(sockPath)
    expect(registered[0].runId).toBe(runId)
    expect(registered[0].ctx.cwd).toBe(cwd)
    expect(plan.extraEnv?.HOME).toBe(process.env.HOME)

    await plan.cleanup?.()
    expect(unregistered).toContain(runId)
  })

  it('passes existing conversation id through prepareCommand', async () => {
    const plan = await adapter.exposePrepareCommand('hi', { ...FULL_OPTS, agentSessionId: 'conv-1' })
    expect(plan.args).toContain('--conversation')
    expect(plan.args[plan.args.indexOf('--conversation') + 1]).toBe('conv-1')
    await plan.cleanup?.()
  })
})

describe('AntigravityAdapter — output and errors', () => {
  it('lets plain stdout pass through the base stream fallback', () => {
    expect(adapter.exposeExtractText({ type: 'anything', content: 'json shaped' })).toBe('')
  })

  it('formats auth failures', () => {
    expect(adapter.exposeHandleError(1, 'Authentication required', '')).toContain('未登录')
  })

  it('surfaces a friendly empty-output fallback', () => {
    expect(adapter.exposeEmptyOutputMessage('', '')).toContain('没有返回可显示内容')
  })
})
