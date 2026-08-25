import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGIM_IM_OPS_START,
  AGIM_MEMORY_LINK_START,
} from './agent-cwd.js'
import {
  seedAccountAgentWorkspace,
  seedAccountWorkspaces,
} from './account-workspace-seed.js'
import { ACCOUNT_MEMORY_STUB } from './agent-workspace-seeds.js'

describe('seedAccountAgentWorkspace', () => {
  let tmpRoot: string
  let prevRoot: string | undefined
  let prevAgimCwd: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'agim-acct-seed-'))
    prevRoot = process.env.AGIM_WORKSPACES_ROOT
    prevAgimCwd = process.env.AGIM_AGIM_CWD
    process.env.AGIM_WORKSPACES_ROOT = tmpRoot
    delete process.env.AGIM_AGIM_CWD
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.AGIM_WORKSPACES_ROOT
    else process.env.AGIM_WORKSPACES_ROOT = prevRoot
    if (prevAgimCwd === undefined) delete process.env.AGIM_AGIM_CWD
    else process.env.AGIM_AGIM_CWD = prevAgimCwd
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('seeds Agim layout from the packaged template, not the shared tree', async () => {
    const shared = join(tmpRoot, 'agim')
    await mkdir(shared, { recursive: true })
    await writeFile(join(shared, 'AGENTS.md'), '你是小马。\n', 'utf8')

    const dir = await seedAccountWorkspaces('usr_seed1')
    expect(dir).toBe(join(tmpRoot, 'users', 'usr_seed1', 'agim'))

    const agents = await readFile(join(dir!, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('你是 Agim')
    expect(agents).toContain('Agim Agent — 行为准则与操作约束')
    expect(agents).not.toContain('你是小马')
    expect(agents).toContain('users/usr_seed1/agim')
    expect(agents).toContain(AGIM_IM_OPS_START)
    expect(agents).toContain(AGIM_MEMORY_LINK_START)

    expect(await readFile(join(dir!, 'MEMORY.md'), 'utf8')).toBe(ACCOUNT_MEMORY_STUB)
    expect((await stat(join(dir!, 'PROJECTS'))).isDirectory()).toBe(true)
    expect((await stat(join(dir!, 'PROJECTS', 'loops'))).isDirectory()).toBe(true)
    expect((await stat(join(dir!, 'SESSIONS'))).isDirectory()).toBe(true)
    expect(await readFile(join(dir!, 'PROJECTS', 'README.md'), 'utf8')).toContain('PROJECTS')
  })

  it('does not overwrite a customized AGENTS.md or MEMORY.md', async () => {
    const dir = await seedAccountAgentWorkspace('usr_seed2', 'agim')
    await writeFile(join(dir!, 'AGENTS.md'), '你是月魁。\n', 'utf8')
    await writeFile(join(dir!, 'MEMORY.md'), '# keep me\n', 'utf8')
    await seedAccountAgentWorkspace('usr_seed2', 'agim')
    expect(await readFile(join(dir!, 'AGENTS.md'), 'utf8')).toContain('你是月魁')
    expect(await readFile(join(dir!, 'MEMORY.md'), 'utf8')).toBe('# keep me\n')
  })

  it('skips non usr_* actors', async () => {
    expect(await seedAccountAgentWorkspace('web:loopback')).toBeNull()
    expect(await seedAccountAgentWorkspace('admin')).toBeNull()
    expect(await seedAccountAgentWorkspace('')).toBeNull()
  })

  it('seeds claude-code with CLAUDE.md and memory/', async () => {
    const dir = await seedAccountAgentWorkspace('usr_seed3', 'claude-code')
    expect(dir).toBe(join(tmpRoot, 'users', 'usr_seed3', 'claude-code'))
    const role = await readFile(join(dir!, 'CLAUDE.md'), 'utf8')
    expect(role).toContain('Claude Code')
    expect(role).toContain(AGIM_IM_OPS_START)
    expect((await stat(join(dir!, 'memory'))).isDirectory()).toBe(true)
    expect(await readFile(join(dir!, 'memory', 'MEMORY.md'), 'utf8')).toContain('auto-memory')
    expect((await stat(join(dir!, 'PROJECTS', 'loops'))).isDirectory()).toBe(true)
  })
})
