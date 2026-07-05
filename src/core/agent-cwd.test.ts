import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAgentCwd,
  defaultAgentCwd,
  agimWorkspacesRoot,
  ensureAgentWorkspace,
  bootstrapAgentWorkspaces,
  AGIM_MEMORY_LINK_START,
} from './agent-cwd.js'

const FULL_IM_OPTS = { threadId: 'thread-A', platform: 'feishu', channelId: 'chan-1', userId: 'u1' }
const NO_IM_OPTS = { model: 'sonnet' }

describe('resolveAgentCwd', () => {
  let tmpRoot: string
  let prevRoot: string | undefined
  let prevClaudeOverride: string | undefined
  let prevOpencodeOverride: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'agim-cwdtest-'))
    prevRoot = process.env.AGIM_WORKSPACES_ROOT
    prevClaudeOverride = process.env.AGIM_CLAUDE_CODE_CWD
    prevOpencodeOverride = process.env.AGIM_OPENCODE_CWD
    process.env.AGIM_WORKSPACES_ROOT = tmpRoot
    delete process.env.AGIM_CLAUDE_CODE_CWD
    delete process.env.AGIM_OPENCODE_CWD
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.AGIM_WORKSPACES_ROOT
    else process.env.AGIM_WORKSPACES_ROOT = prevRoot
    if (prevClaudeOverride === undefined) delete process.env.AGIM_CLAUDE_CODE_CWD
    else process.env.AGIM_CLAUDE_CODE_CWD = prevClaudeOverride
    if (prevOpencodeOverride === undefined) delete process.env.AGIM_OPENCODE_CWD
    else process.env.AGIM_OPENCODE_CWD = prevOpencodeOverride
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns default workspace dir when full IM context is present', () => {
    expect(resolveAgentCwd('claude-code', FULL_IM_OPTS)).toBe(join(tmpRoot, 'claude-code'))
  })

  it('returns undefined for non-IM call (web/scheduler), preserving inherited cwd', () => {
    expect(resolveAgentCwd('claude-code', NO_IM_OPTS)).toBeUndefined()
  })

  it('returns undefined when only one of threadId/platform is set', () => {
    expect(resolveAgentCwd('claude-code', { threadId: 't1' })).toBeUndefined()
    expect(resolveAgentCwd('claude-code', { platform: 'feishu' })).toBeUndefined()
  })

  it('env override beats default IM dir', () => {
    process.env.AGIM_CLAUDE_CODE_CWD = '/srv/explicit'
    expect(resolveAgentCwd('claude-code', FULL_IM_OPTS)).toBe('/srv/explicit')
  })

  it('env override also wins for non-IM calls (admin escape hatch)', () => {
    process.env.AGIM_CLAUDE_CODE_CWD = '/srv/explicit'
    expect(resolveAgentCwd('claude-code', NO_IM_OPTS)).toBe('/srv/explicit')
  })

  it('env key respects per-agent naming (hyphen to underscore, uppercase)', () => {
    process.env.AGIM_OPENCODE_CWD = '/srv/oc'
    expect(resolveAgentCwd('opencode', FULL_IM_OPTS)).toBe('/srv/oc')
    expect(resolveAgentCwd('claude-code', FULL_IM_OPTS)).toBe(join(tmpRoot, 'claude-code'))
  })

  it('AGIM_WORKSPACES_ROOT moves the default for every agent at once', () => {
    expect(agimWorkspacesRoot()).toBe(tmpRoot)
    expect(defaultAgentCwd('claude-code')).toBe(join(tmpRoot, 'claude-code'))
    expect(defaultAgentCwd('opencode')).toBe(join(tmpRoot, 'opencode'))
  })
})

describe('ensureAgentWorkspace', () => {
  let tmpRoot: string
  let prevRoot: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'agim-cwdtest-'))
    prevRoot = process.env.AGIM_WORKSPACES_ROOT
    process.env.AGIM_WORKSPACES_ROOT = tmpRoot
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.AGIM_WORKSPACES_ROOT
    else process.env.AGIM_WORKSPACES_ROOT = prevRoot
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('creates the dir and seed file when missing', async () => {
    const dir = await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: '# seed' })
    expect(dir).toBe(join(tmpRoot, 'claude-code'))
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# seed')
  })

  it('does NOT overwrite an existing seed file', async () => {
    const dir = join(tmpRoot, 'claude-code')
    await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: '# seed' })
    await writeFile(join(dir, 'CLAUDE.md'), 'USER EDITED', 'utf8')
    await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: '# new seed' })
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe('USER EDITED')
  })

  it('is fully idempotent across many calls', async () => {
    for (let i = 0; i < 5; i++) {
      await ensureAgentWorkspace('opencode', { filename: 'AGENTS.md', content: '# x' })
    }
    expect(await readFile(join(tmpRoot, 'opencode', 'AGENTS.md'), 'utf8')).toBe('# x')
  })

  it('honors AGIM_<AGENT>_CWD override and bootstraps THAT path instead', async () => {
    const altDir = join(tmpRoot, 'custom-spot')
    process.env.AGIM_CLAUDE_CODE_CWD = altDir
    try {
      const dir = await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: '# alt' })
      expect(dir).toBe(altDir)
      expect(await readFile(join(altDir, 'CLAUDE.md'), 'utf8')).toBe('# alt')
      let defaultExists = false
      try { await access(join(tmpRoot, 'claude-code')); defaultExists = true } catch { /* expected */ }
      expect(defaultExists).toBe(false)
    } finally {
      delete process.env.AGIM_CLAUDE_CODE_CWD
    }
  })
})

describe('bootstrapAgentWorkspaces', () => {
  let tmpRoot: string
  let prevRoot: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'agim-cwdtest-'))
    prevRoot = process.env.AGIM_WORKSPACES_ROOT
    process.env.AGIM_WORKSPACES_ROOT = tmpRoot
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.AGIM_WORKSPACES_ROOT
    else process.env.AGIM_WORKSPACES_ROOT = prevRoot
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('creates built-in agent workspaces with their canonical seed files', async () => {
    const result = await bootstrapAgentWorkspaces()
    const byAgent = Object.fromEntries(result.map((r) => [r.agent, r.dir]))
    expect(byAgent['claude-code']).toBe(join(tmpRoot, 'claude-code'))
    expect(byAgent.opencode).toBe(join(tmpRoot, 'opencode'))
    expect(byAgent.mimo).toBe(join(tmpRoot, 'mimo'))
    expect(byAgent.copilot).toBe(join(tmpRoot, 'copilot'))
    expect(await readFile(join(tmpRoot, 'claude-code', 'CLAUDE.md'), 'utf8')).toContain('Claude Code')
    expect(await readFile(join(tmpRoot, 'opencode', 'AGENTS.md'), 'utf8')).toContain('OpenCode')
    expect(await readFile(join(tmpRoot, 'mimo', 'AGENTS.md'), 'utf8')).toContain('MiMo Code')
    expect(await readFile(join(tmpRoot, 'copilot', 'AGENTS.md'), 'utf8')).toContain('GitHub Copilot CLI')
    expect(await readFile(join(tmpRoot, 'claude-code', 'CLAUDE.md'), 'utf8')).toContain(AGIM_MEMORY_LINK_START)
    expect(await readFile(join(tmpRoot, 'opencode', 'AGENTS.md'), 'utf8')).toContain(AGIM_MEMORY_LINK_START)
    expect(await readFile(join(tmpRoot, 'mimo', 'AGENTS.md'), 'utf8')).toContain(AGIM_MEMORY_LINK_START)
    expect(await readFile(join(tmpRoot, 'copilot', 'AGENTS.md'), 'utf8')).toContain(AGIM_MEMORY_LINK_START)
  })

  it('safe to run twice and preserves user edits while adding the memory link once', async () => {
    await bootstrapAgentWorkspaces()
    await writeFile(join(tmpRoot, 'claude-code', 'CLAUDE.md'), 'USER', 'utf8')
    await bootstrapAgentWorkspaces()
    const content = await readFile(join(tmpRoot, 'claude-code', 'CLAUDE.md'), 'utf8')
    expect(content).toContain('USER')
    expect(content).not.toContain('Claude Code — IM 入口工作区')
    expect(content.match(/agim:memory-link:start/g)?.length).toBe(1)
  })
})
