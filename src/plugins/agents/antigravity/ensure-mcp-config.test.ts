import { describe, it, expect } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureAgimMcp, removeAgimMcp } from './ensure-mcp-config.js'

describe('Antigravity MCP config injector', () => {
  it('writes agim entry and preserves existing servers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agim-antigravity-mcp-'))
    const file = join(dir, 'mcp_config.json')
    await writeFile(file, JSON.stringify({
      mcpServers: {
        other: { command: 'uvx', args: ['some-server'] },
      },
      custom: true,
    }), 'utf8')

    await ensureAgimMcp(
      { command: 'node', args: ['sidecar.js'], env: { AGIM_APPROVAL_SOCK: '/tmp/agim.sock' } },
      { path: file },
    )
    await ensureAgimMcp(
      { command: 'node', args: ['sidecar.js'], env: { AGIM_APPROVAL_SOCK: '/tmp/agim.sock' } },
      { path: file },
    )

    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      custom?: boolean
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
    }
    expect(raw.custom).toBe(true)
    expect(raw.mcpServers.other.command).toBe('uvx')
    expect(raw.mcpServers.agim.command).toBe('node')
    expect(raw.mcpServers.agim.args).toEqual(['sidecar.js'])
    expect(raw.mcpServers.agim.env?.AGIM_APPROVAL_SOCK).toBe('/tmp/agim.sock')
  })

  it('removes only the agim entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agim-antigravity-mcp-'))
    const file = join(dir, 'mcp_config.json')
    await ensureAgimMcp({ command: 'node', args: ['sidecar.js'] }, { path: file })
    await removeAgimMcp({ path: file })
    const raw = JSON.parse(await readFile(file, 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(raw.mcpServers.agim).toBeUndefined()
  })
})
