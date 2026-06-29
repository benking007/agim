import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureOpencodeMcpRegistered } from './ensure-mcp-config.js'

let previousConfigPath: string | undefined
let root: string | null = null

beforeEach(async () => {
  previousConfigPath = process.env.OPENCODE_CONFIG_PATH
  root = await mkdtemp(join(tmpdir(), 'agim-opencode-mcp-'))
  process.env.OPENCODE_CONFIG_PATH = join(root, 'opencode.json')
})

afterEach(async () => {
  if (previousConfigPath === undefined) delete process.env.OPENCODE_CONFIG_PATH
  else process.env.OPENCODE_CONFIG_PATH = previousConfigPath

  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function readConfig(): Promise<Record<string, unknown>> {
  const raw = await readFile(process.env.OPENCODE_CONFIG_PATH!, 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('ensureOpencodeMcpRegistered', () => {
  it('adds mcp.agim and preserves existing opencode config', async () => {
    await writeFile(process.env.OPENCODE_CONFIG_PATH!, JSON.stringify({
      theme: 'dark',
      mcp: {
        existing: { type: 'local', command: ['node', 'x.js'] },
      },
    }), 'utf8')

    const changed = await ensureOpencodeMcpRegistered()
    const cfg = await readConfig()
    const mcp = cfg.mcp as Record<string, unknown>
    const agim = mcp.agim as { type: string; command: string[]; enabled: boolean }

    expect(changed).toBe(true)
    expect(cfg.theme).toBe('dark')
    expect(mcp.existing).toEqual({ type: 'local', command: ['node', 'x.js'] })
    const retiredKey = ['im', 'hub'].join('')
    expect(mcp[retiredKey]).toBeUndefined()
    expect(agim.type).toBe('local')
    expect(agim.command[0]).toBe(process.execPath)
    expect(agim.command[1].endsWith('src/plugins/agents/claude-code/mcp-approval-server.js')).toBe(true)
    expect(agim.enabled).toBe(true)
  })

  it('is idempotent once mcp.agim is already registered', async () => {
    const first = await ensureOpencodeMcpRegistered()
    const second = await ensureOpencodeMcpRegistered()

    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  it('skips malformed JSON instead of overwriting user config', async () => {
    await writeFile(process.env.OPENCODE_CONFIG_PATH!, '{ not-json', 'utf8')

    const changed = await ensureOpencodeMcpRegistered()
    const raw = await readFile(process.env.OPENCODE_CONFIG_PATH!, 'utf8')

    expect(changed).toBe(false)
    expect(raw).toBe('{ not-json')
  })
})
