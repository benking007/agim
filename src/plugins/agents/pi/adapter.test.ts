import { describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSendOpts } from '../../../core/types.js'
import { PI_AGIM_MUTATION_TOOL_NAMES, PI_AGIM_TOOL_NAMES, PiAdapter } from './index.js'

class PiAdapterTestable extends PiAdapter {
  exposeCommandName(): string {
    return this.commandName
  }

  exposeBuildArgs(prompt: string, opts: Record<string, unknown>): string[] {
    return this.buildArgs(prompt, opts as AgentSendOpts)
  }

  exposeExtractText(event: unknown): string {
    return this.extractText(event)
  }

  exposeInspectEvent(event: unknown, opts: Record<string, unknown>): void {
    this.inspectEvent(event, opts as AgentSendOpts)
  }

  exposeHandleError(code: number, stderr: string, errorMessage: string): string | null {
    return this.handleError(code, stderr, errorMessage)
  }
}

const adapter = new PiAdapterTestable()

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

describe('PiAdapter — identity', () => {
  it('exposes name + aliases + kind', () => {
    expect(adapter.name).toBe('pi')
    expect(adapter.aliases).toEqual(['pi-agent'])
    expect(adapter.kind).toBe('cli')
  })
})

describe('PiAdapter — command resolution', () => {
  it('honors AGIM_PI_BIN', () => {
    withEnv({ AGIM_PI_BIN: '/tmp/pi-custom' }, () => {
      expect(new PiAdapterTestable().exposeCommandName()).toBe('/tmp/pi-custom')
    })
  })

  it('finds pi in HOME/.local/bin', async () => {
    const oldHome = process.env.HOME
    const dir = await mkdtemp(join(tmpdir(), 'agim-pi-home-'))
    const localBin = join(dir, '.local', 'bin')
    const bin = join(localBin, 'pi')
    await mkdir(localBin, { recursive: true })
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(bin, 0o755)

    process.env.HOME = dir
    try {
      expect(new PiAdapterTestable().exposeCommandName()).toBe(bin)
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = oldHome
      }
    }
  })
})

describe('PiAdapter — buildArgs', () => {
  it('uses JSON print mode with read-only + Agim tools by default', () => {
    withEnv({ AGIM_PI_ALLOW_MUTATION_TOOLS: undefined }, () => {
      const args = adapter.exposeBuildArgs('hello', {})
      expect(args.slice(0, 5)).toEqual(['--mode', 'json', '--print', '--approve', '--tools'])
      const tools = args[args.indexOf('--tools') + 1].split(',')
      expect(tools).toContain('read')
      expect(tools).toContain('grep')
      expect(tools).toContain('find')
      expect(tools).toContain('ls')
      expect(tools).toContain('web_search')
      expect(tools).toContain('web_fetch')
      for (const name of PI_AGIM_TOOL_NAMES) expect(tools).toContain(name)
      for (const name of PI_AGIM_MUTATION_TOOL_NAMES) expect(tools).toContain(name)
      expect(tools).not.toContain('bash')
      expect(tools).not.toContain('edit')
      expect(tools).not.toContain('write')
      expect(tools).not.toContain('native_exec')
      expect(args.at(-1)).toBe('hello')
    })
  })

  it('passes session id via --session', () => {
    const args = adapter.exposeBuildArgs('next', { agentSessionId: 'pi-session' })
    expect(args).toContain('--session')
    expect(args[args.indexOf('--session') + 1]).toBe('pi-session')
  })

  it('passes model when present', () => {
    const args = adapter.exposeBuildArgs('hi', { model: 'anthropic/claude-sonnet-4-5' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-5')
  })

  it('keeps PI native mutation tools blocked even if the legacy env switch is set', () => {
    withEnv({ AGIM_PI_ALLOW_MUTATION_TOOLS: '1' }, () => {
      const args = adapter.exposeBuildArgs('edit this', {})
      expect(args).toContain('--tools')
      const tools = args[args.indexOf('--tools') + 1].split(',')
      for (const name of PI_AGIM_MUTATION_TOOL_NAMES) expect(tools).toContain(name)
      expect(tools).not.toContain('bash')
      expect(tools).not.toContain('edit')
      expect(tools).not.toContain('write')
    })
  })

  it('keeps plan mode read-only even when the legacy env switch is set', () => {
    withEnv({ AGIM_PI_ALLOW_MUTATION_TOOLS: '1' }, () => {
      const args = adapter.exposeBuildArgs('review only', { planMode: true })
      expect(args).toContain('--tools')
      const tools = args[args.indexOf('--tools') + 1].split(',')
      expect(tools).toContain('read')
      for (const name of PI_AGIM_MUTATION_TOOL_NAMES) expect(tools).not.toContain(name)
    })
  })
})

describe('PiAdapter — extractText', () => {
  it('extracts assistant text deltas', () => {
    expect(adapter.exposeExtractText({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    })).toBe('hello')
  })

  it('ignores message_end to avoid double emission', () => {
    expect(adapter.exposeExtractText({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })).toBe('')
  })
})

describe('PiAdapter — inspectEvent', () => {
  it('captures session id from session header', () => {
    let captured = ''
    adapter.exposeInspectEvent(
      { type: 'session', id: 'pi-session-1' },
      { onAgentSessionId: (id: string) => { captured = id } },
    )
    expect(captured).toBe('pi-session-1')
  })

  it('does not re-capture when caller already has a session id', () => {
    let captured = ''
    adapter.exposeInspectEvent(
      { type: 'session', id: 'pi-session-2' },
      { agentSessionId: 'existing', onAgentSessionId: (id: string) => { captured = id } },
    )
    expect(captured).toBe('')
  })

  it('forwards usage tokens from assistant message_end', () => {
    const deltas: Array<Record<string, number | undefined>> = []
    adapter.exposeInspectEvent(
      {
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 11, output: 7 } },
      },
      { onUsage: (d: Record<string, number | undefined>) => { deltas.push(d) } },
    )
    expect(deltas).toEqual([{ tokensInput: 11, tokensOutput: 7 }])
  })
})

describe('PiAdapter — errors', () => {
  it('formats missing API key errors', () => {
    const msg = adapter.exposeHandleError(1, 'No API key found for the selected model.', '')
    expect(msg).toContain('PI 未登录')
    expect(msg).toContain('pi /login')
  })
})
