import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AgentSendOpts } from '../../../core/types.js'
import { ApprovalBus, approvalBus, type RunContext } from '../../../core/approval-bus.js'
import { QoderAdapter } from './index.js'

class QoderAdapterTestable extends QoderAdapter {
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

const adapter = new QoderAdapterTestable()
const FULL_OPTS = {
  threadId: 'thread-A',
  platform: 'feishu',
  channelId: 'chan-1',
  userId: 'u1',
}

function uniqueSocketPath(): string {
  return join(tmpdir(), `agim-qoder-adapter-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
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
    fn()
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

describe('QoderAdapter — identity', () => {
  it('exposes name + aliases + kind', () => {
    expect(adapter.name).toBe('qoder')
    expect(adapter.aliases).toEqual(['qd', 'qodercli'])
    expect(adapter.kind).toBe('cli')
  })
})

describe('QoderAdapter — command resolution', () => {
  it('honors AGIM_QODER_BIN', async () => {
    const old = process.env.AGIM_QODER_BIN
    process.env.AGIM_QODER_BIN = '/tmp/qodercli-custom'
    try {
      expect(new QoderAdapterTestable().exposeCommandName()).toBe('/tmp/qodercli-custom')
    } finally {
      if (old === undefined) {
        delete process.env.AGIM_QODER_BIN
      } else {
        process.env.AGIM_QODER_BIN = old
      }
    }
  })

  it('finds qodercli in HOME/.local/bin', async () => {
    const oldHome = process.env.HOME
    const dir = await mkdtemp(join(tmpdir(), 'agim-qoder-home-'))
    const localBin = join(dir, '.local', 'bin')
    const bin = join(localBin, 'qodercli')
    await mkdir(localBin, { recursive: true })
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(bin, 0o755)

    process.env.HOME = dir
    try {
      expect(new QoderAdapterTestable().exposeCommandName()).toBe(bin)
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = oldHome
      }
    }
  })
})

describe('QoderAdapter — buildArgs', () => {
  it('uses print stream-json mode with headless-safe tool defaults', () => {
    withEnv({ AGIM_QODER_PERMISSION_MODE: undefined, AGIM_QODER_ALLOW_MUTATION_TOOLS: undefined }, () => {
      const args = adapter.exposeBuildArgs('hello', {})
      expect(args.slice(0, 3)).toEqual(['--print', '--output-format', 'stream-json'])
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypass_permissions')
      expect(args[args.indexOf('--allowed-tools') + 1]).toBe('WebSearch,WebFetch,mcp__agim__*')
      expect(args[args.indexOf('--disallowed-tools') + 1]).toBe(
        'Bash,Edit,Write,NotebookEdit,CronCreate,CronDelete',
      )
      expect(args.at(-1)).toBe('hello')
    })
  })

  it('passes session id via --resume', () => {
    const args = adapter.exposeBuildArgs('next', { agentSessionId: 'qoder-session' })
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('qoder-session')
  })

  it('passes model when present', () => {
    const args = adapter.exposeBuildArgs('hi', { model: 'claude-sonnet-4-5' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-5')
  })

  it('restricts mutation-oriented tools in plan mode', () => {
    withEnv({ AGIM_QODER_PERMISSION_MODE: undefined, AGIM_QODER_ALLOW_MUTATION_TOOLS: undefined }, () => {
      const args = adapter.exposeBuildArgs('design only', { planMode: true })
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('default')
      expect(args[args.indexOf('--allowed-tools') + 1]).toBe('WebSearch,WebFetch,mcp__agim__*')
      expect(args[args.indexOf('--disallowed-tools') + 1]).toContain('Bash')
      expect(args[args.indexOf('--disallowed-tools') + 1]).toContain('Write')
    })
  })

  it('lets operators override Qoder permission mode', () => {
    withEnv({ AGIM_QODER_PERMISSION_MODE: 'dont_ask' }, () => {
      const args = adapter.exposeBuildArgs('hello', {})
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('dont_ask')
    })
  })

  it('keeps native mutation tools blocked even if the legacy env switch is set', () => {
    withEnv({ AGIM_QODER_ALLOW_MUTATION_TOOLS: '1' }, () => {
      const args = adapter.exposeBuildArgs('edit this', {})
      expect(args).toContain('--disallowed-tools')
      expect(args[args.indexOf('--disallowed-tools') + 1]).toBe(
        'Bash,Edit,Write,NotebookEdit,CronCreate,CronDelete',
      )
    })
  })
})

describe('QoderAdapter — approval-routed MCP', () => {
  let bus: ApprovalBus
  let adapter: QoderAdapterTestable
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
    workspaceRoot = await mkdtemp(join(tmpdir(), 'agim-qoder-workspaces-'))
    oldWorkspaceRoot = process.env.AGIM_WORKSPACES_ROOT
    process.env.AGIM_WORKSPACES_ROOT = workspaceRoot
    adapter = new QoderAdapterTestable()
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
  })

  it('embeds runId in inline MCP config and registers the same cwd', async () => {
    const plan = await adapter.exposePrepareCommand('hi', FULL_OPTS)
    const cfgIdx = plan.args.indexOf('--mcp-config')
    expect(cfgIdx).toBeGreaterThanOrEqual(0)
    const parsed = JSON.parse(plan.args[cfgIdx + 1]) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
    }
    const env = parsed.mcpServers.agim.env ?? {}
    const sockPath = bus.getSocketPath()
    const runId = env.AGIM_RUN_ID
    const planRunId = plan.extraEnv?.AGIM_RUN_ID
    if (!sockPath || !runId || !planRunId) throw new Error('missing MCP approval env')
    expect(env.AGIM_APPROVAL_SOCK).toBe(sockPath)
    expect(runId).toBe(planRunId)
    expect(registered[0].runId).toBe(runId)
    expect(registered[0].ctx.cwd).toBe(plan.cwd)
    expect(plan.cwd?.startsWith(workspaceRoot)).toBe(true)
    expect(plan.args).toContain('--allowed-mcp-server-names')
    expect(plan.args[plan.args.indexOf('--allowed-mcp-server-names') + 1]).toBe('agim')

    await plan.cleanup?.()
    expect(unregistered).toContain(runId)
  })
})

describe('QoderAdapter — extractText', () => {
  it('extracts assistant content arrays', () => {
    expect(adapter.exposeExtractText({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })).toBe('hello')
  })

  it('extracts assistant string content', () => {
    expect(adapter.exposeExtractText({
      type: 'assistant',
      message: { role: 'assistant', content: 'plain' },
    })).toBe('plain')
  })

  it('ignores result events to avoid double emission', () => {
    expect(adapter.exposeExtractText({ type: 'result', result: 'done' })).toBe('')
  })

  it('ignores synthetic error assistant events so handleError can format them', () => {
    expect(adapter.exposeExtractText({
      type: 'assistant',
      error: 'authentication_failed',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in' }] },
    })).toBe('')
  })
})

describe('QoderAdapter — inspectEvent', () => {
  it('captures session id from init events', () => {
    let captured = ''
    adapter.exposeInspectEvent(
      { type: 'system', subtype: 'init', session_id: 'qoder-session-1' },
      { onAgentSessionId: (id: string) => { captured = id } },
    )
    expect(captured).toBe('qoder-session-1')
  })

  it('does not re-capture when caller already has a session id', () => {
    let captured = ''
    adapter.exposeInspectEvent(
      { type: 'system', subtype: 'init', session_id: 'qoder-session-2' },
      { agentSessionId: 'existing', onAgentSessionId: (id: string) => { captured = id } },
    )
    expect(captured).toBe('')
  })

  it('forwards usage tokens including cache tokens', () => {
    const deltas: Array<Record<string, number | undefined>> = []
    adapter.exposeInspectEvent(
      {
        type: 'result',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
          output_tokens: 7,
        },
      },
      { onUsage: (d: Record<string, number | undefined>) => { deltas.push(d) } },
    )
    expect(deltas).toEqual([{ tokensInput: 15, tokensOutput: 7 }])
  })
})
