import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AgentSendOpts } from '../../../core/types.js'
import { ApprovalBus, approvalBus, type RunContext } from '../../../core/approval-bus.js'
import { MimoAdapter } from './index.js'

class MimoAdapterTestable extends MimoAdapter {
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

const adapter = new MimoAdapterTestable()
const FULL_OPTS = {
  threadId: 'thread-A',
  platform: 'feishu',
  channelId: 'chan-1',
  userId: 'u1',
}

function uniqueSocketPath(): string {
  return join(tmpdir(), `agim-mimo-adapter-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
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

describe('MimoAdapter — identity', () => {
  it('exposes name + aliases + kind', () => {
    expect(adapter.name).toBe('mimo')
    expect(adapter.aliases).toEqual(['mo', 'mimo-code'])
    expect(adapter.kind).toBe('cli')
  })
})

describe('MimoAdapter — command resolution', () => {
  it('honors AGIM_MIMO_BIN', () => {
    withEnv({ AGIM_MIMO_BIN: '/tmp/mimo-custom' }, () => {
      expect(new MimoAdapterTestable().exposeCommandName()).toBe('/tmp/mimo-custom')
    })
  })

  it('finds mimo in HOME/.mimocode/bin', async () => {
    const oldHome = process.env.HOME
    const dir = await mkdtemp(join(tmpdir(), 'agim-mimo-home-'))
    const mimoBin = join(dir, '.mimocode', 'bin')
    const bin = join(mimoBin, 'mimo')
    await mkdir(mimoBin, { recursive: true })
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(bin, 0o755)

    process.env.HOME = dir
    try {
      expect(new MimoAdapterTestable().exposeCommandName()).toBe(bin)
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = oldHome
      }
    }
  })
})

describe('MimoAdapter — buildArgs', () => {
  it('uses run json mode', () => {
    expect(adapter.exposeBuildArgs('hello', {})).toEqual(['run', '--format', 'json', 'hello'])
  })

  it('passes session id via --session', () => {
    const args = adapter.exposeBuildArgs('next', { agentSessionId: 'mimo-session' })
    expect(args).toContain('--session')
    expect(args[args.indexOf('--session') + 1]).toBe('mimo-session')
  })

  it('passes provider/model when present', () => {
    const args = adapter.exposeBuildArgs('hi', { model: 'kimi/kimi-k2-0711-preview' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('kimi/kimi-k2-0711-preview')
  })
})

describe('MimoAdapter — approval-routed MCP', () => {
  let bus: ApprovalBus
  let adapter: MimoAdapterTestable
  let workspaceRoot: string
  let oldWorkspaceRoot: string | undefined
  let originalGetSocketPath: () => string | null
  let originalRegisterRun: typeof approvalBus.registerRun
  let originalUnregisterRun: typeof approvalBus.unregisterRun
  let registered: Array<{ runId: string; ctx: RunContext }>
  let unregistered: string[]
  let oldConfigContent: string | undefined
  let oldPermission: string | undefined

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
    workspaceRoot = await mkdtemp(join(tmpdir(), 'agim-mimo-workspaces-'))
    oldWorkspaceRoot = process.env.AGIM_WORKSPACES_ROOT
    process.env.AGIM_WORKSPACES_ROOT = workspaceRoot
    oldConfigContent = process.env.MIMOCODE_CONFIG_CONTENT
    oldPermission = process.env.MIMOCODE_PERMISSION
    delete process.env.MIMOCODE_CONFIG_CONTENT
    delete process.env.MIMOCODE_PERMISSION
    adapter = new MimoAdapterTestable()
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
    if (oldConfigContent === undefined) {
      delete process.env.MIMOCODE_CONFIG_CONTENT
    } else {
      process.env.MIMOCODE_CONFIG_CONTENT = oldConfigContent
    }
    if (oldPermission === undefined) {
      delete process.env.MIMOCODE_PERMISSION
    } else {
      process.env.MIMOCODE_PERMISSION = oldPermission
    }
  })

  it('embeds runId in inline MCP config and registers the same cwd', async () => {
    const plan = await adapter.exposePrepareCommand('hi', FULL_OPTS)
    const cfg = JSON.parse(plan.extraEnv?.MIMOCODE_CONFIG_CONTENT ?? '{}') as {
      mcp?: Record<string, { type?: string; command?: string[]; enabled?: boolean; environment?: Record<string, string> }>
    }
    const permission = JSON.parse(plan.extraEnv?.MIMOCODE_PERMISSION ?? '{}') as Record<string, string>
    const agim = cfg.mcp?.agim
    const sockPath = bus.getSocketPath()
    const runId = agim?.environment?.AGIM_RUN_ID
    const planRunId = plan.extraEnv?.AGIM_RUN_ID
    if (!sockPath || !runId || !planRunId) throw new Error('missing MCP approval env')

    expect(agim?.type).toBe('local')
    expect(agim?.enabled).toBe(true)
    expect(agim?.command?.[0]).toBe(process.execPath)
    expect(agim?.command?.[1]?.endsWith('mcp-approval-server.js')).toBe(true)
    expect(agim?.environment?.AGIM_APPROVAL_SOCK).toBe(sockPath)
    expect(runId).toBe(planRunId)
    expect(registered[0].runId).toBe(runId)
    expect(registered[0].ctx.cwd).toBe(plan.cwd)
    expect(plan.cwd?.startsWith(workspaceRoot)).toBe(true)
    expect(permission.websearch).toBe('allow')
    expect(permission.webfetch).toBe('allow')
    expect(permission.bash).toBe('deny')
    expect(permission.edit).toBe('deny')
    expect(permission.external_directory).toBe('deny')

    await plan.cleanup?.()
    expect(unregistered).toContain(runId)
  })

  it('preserves existing MiMo config and permission entries while overriding risky tools', async () => {
    process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
      mcp: {
        fetch: { type: 'local', command: ['uvx', 'mcp-server-fetch'], enabled: true },
      },
      custom: true,
    })
    process.env.MIMOCODE_PERMISSION = JSON.stringify({ read: 'allow', bash: 'allow' })

    const plan = await adapter.exposePrepareCommand('hi', FULL_OPTS)
    const cfg = JSON.parse(plan.extraEnv?.MIMOCODE_CONFIG_CONTENT ?? '{}') as {
      mcp?: Record<string, unknown>
      custom?: boolean
    }
    const permission = JSON.parse(plan.extraEnv?.MIMOCODE_PERMISSION ?? '{}') as Record<string, string>

    expect(cfg.custom).toBe(true)
    expect(cfg.mcp?.fetch).toBeTruthy()
    expect(cfg.mcp?.agim).toBeTruthy()
    expect(permission.read).toBe('allow')
    expect(permission.bash).toBe('deny')

    await plan.cleanup?.()
  })
})

describe('MimoAdapter — extractText', () => {
  it('extracts assistant content arrays', () => {
    expect(adapter.exposeExtractText({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })).toBe('hello')
  })

  it('extracts assistant string content', () => {
    expect(adapter.exposeExtractText({
      type: 'message',
      message: { role: 'assistant', content: 'plain' },
    })).toBe('plain')
  })

  it('extracts delta text', () => {
    expect(adapter.exposeExtractText({ type: 'delta', delta: { text: 'chunk' } })).toBe('chunk')
    expect(adapter.exposeExtractText({ type: 'assistant_delta', delta: 'raw' })).toBe('raw')
  })

  it('extracts MiMo raw json text parts', () => {
    expect(adapter.exposeExtractText({
      type: 'text',
      sessionID: 'ses-1',
      part: {
        type: 'text',
        text: '你好！我是 MiMo Code。',
      },
    })).toBe('你好！我是 MiMo Code。')
  })

  it('ignores result events to avoid double emission', () => {
    expect(adapter.exposeExtractText({ type: 'result', result: 'done' })).toBe('')
  })

  it('ignores synthetic error events so handleError can format them', () => {
    expect(adapter.exposeExtractText({ type: 'error', error: 'boom' })).toBe('')
  })
})

describe('MimoAdapter — inspectEvent', () => {
  it('captures fresh session ids', () => {
    let captured = ''
    adapter.exposeInspectEvent({ type: 'session', session_id: 'mimo-1' }, {
      onAgentSessionId: (id: string) => { captured = id },
    })
    expect(captured).toBe('mimo-1')
  })

  it('captures session ids from MiMo raw json events', () => {
    let captured = ''
    adapter.exposeInspectEvent({
      type: 'text',
      sessionID: 'ses-top',
      part: { type: 'text', sessionID: 'ses-part', text: 'hello' },
    }, {
      onAgentSessionId: (id: string) => { captured = id },
    })
    expect(captured).toBe('ses-top')
  })

  it('does not overwrite an existing resumed session id', () => {
    let called = false
    adapter.exposeInspectEvent({ type: 'session', session_id: 'mimo-2' }, {
      agentSessionId: 'existing',
      onAgentSessionId: () => { called = true },
    })
    expect(called).toBe(false)
  })

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

  it('reports usage deltas from MiMo step-finish parts', () => {
    let input = 0
    let output = 0
    adapter.exposeInspectEvent({
      type: 'step_finish',
      part: {
        type: 'step-finish',
        tokens: {
          input: 187,
          output: 16,
          cache: { write: 0, read: 24640 },
        },
      },
    }, {
      onUsage: (delta: { tokensInput?: number; tokensOutput?: number }) => {
        input = delta.tokensInput ?? 0
        output = delta.tokensOutput ?? 0
      },
    })
    expect(input).toBe(24827)
    expect(output).toBe(16)
  })
})
