import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAgentCwd,
  resolveAgentWorkspaceRoot,
  buildPortalWorkspaceHint,
  defaultAgentCwd,
  resolveAgentFilesRoot,
  agimWorkspacesRoot,
  ensureAgentWorkspace,
  ensureAgimImOpsGuide,
  planImOpsUpsert,
  bootstrapAgentWorkspaces,
  buildAgimImOpsBlock,
  bindableWorkspacePath,
  isAccountWorkspaceUserId,
  AGIM_MEMORY_LINK_START,
  AGIM_IM_OPS_START,
  AGIM_IM_OPS_END,
  AGIM_IM_OPS_FREEZE,
  AGIM_BGJOB_WRAPPER_EXPR,
} from './agent-cwd.js'
import { runWithAccountUser } from './accounts.js'

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

  it('pins IM+account ALS to ~/.agim-workspaces/users/<id>/<agent>', () => {
    const cwd = runWithAccountUser('usr_abc123', () => resolveAgentCwd('claude-code', FULL_IM_OPTS))
    expect(cwd).toBe(join(tmpRoot, 'users', 'usr_abc123', 'claude-code'))
  })

  it('pins web+usr_* userId even when ALS is empty', () => {
    expect(resolveAgentCwd('agim', {
      threadId: 'web-thread1',
      platform: 'web',
      userId: 'usr_abc123',
    })).toBe(join(tmpRoot, 'users', 'usr_abc123', 'agim'))
  })

  it('does not treat web: token ids as Portal accounts', () => {
    expect(isAccountWorkspaceUserId('web:tok1')).toBe(false)
    expect(isAccountWorkspaceUserId('usr_abc123')).toBe(true)
    expect(resolveAgentCwd('agim', {
      threadId: 'web-thread1',
      platform: 'web',
      userId: 'web:tok1',
    })).toBe(join(tmpRoot, 'agim'))
  })

  it('ignores a shared-tree workspacePath once an account is in scope', () => {
    const stale = join(tmpRoot, 'agim', 'old-proj')
    mkdirSync(stale, { recursive: true })
    const cwd = runWithAccountUser('usr_abc123', () => resolveAgentCwd('agim', {
      threadId: 'web-thread1',
      platform: 'web',
      userId: 'usr_abc123',
      workspacePath: stale,
    }))
    expect(cwd).toBe(join(tmpRoot, 'users', 'usr_abc123', 'agim'))
  })

  it('keeps a subdirectory that already lives under the account tree', () => {
    const child = join(tmpRoot, 'users', 'usr_abc123', 'agim', 'proj')
    mkdirSync(child, { recursive: true })
    const cwd = runWithAccountUser('usr_abc123', () => resolveAgentCwd('agim', {
      threadId: 'web-thread1',
      platform: 'web',
      userId: 'usr_abc123',
      workspacePath: child,
    }))
    expect(cwd).toBe(child)
  })

  it('bindableWorkspacePath drops shared-tree leftovers for usr_*', () => {
    expect(bindableWorkspacePath(join(tmpRoot, 'agim', 'x'), 'agim', 'usr_abc123')).toBeUndefined()
    const child = join(tmpRoot, 'users', 'usr_abc123', 'agim', 'x')
    expect(bindableWorkspacePath(child, 'agim', 'usr_abc123')).toBe(child)
  })

  it('returns default workspace dir when full IM context is present', () => {
    expect(resolveAgentCwd('claude-code', FULL_IM_OPTS)).toBe(join(tmpRoot, 'claude-code'))
  })

  it('resolveAgentFilesRoot uses the account tree when a user id is set', () => {
    expect(resolveAgentFilesRoot('agim', 'usr_abc123')).toBe(join(tmpRoot, 'users', 'usr_abc123', 'agim'))
    expect(resolveAgentFilesRoot('agim', 'web:tok1')).toBe(join(tmpRoot, 'agim'))
    expect(resolveAgentFilesRoot('agim')).toBe(join(tmpRoot, 'agim'))
  })

  it('returns undefined for non-IM call (web/scheduler), preserving inherited cwd', () => {
    expect(resolveAgentCwd('claude-code', NO_IM_OPTS)).toBeUndefined()
  })

  it('returns undefined when only one of threadId/platform is set', () => {
    expect(resolveAgentCwd('claude-code', { threadId: 't1' })).toBeUndefined()
    expect(resolveAgentCwd('claude-code', { platform: 'feishu' })).toBeUndefined()
  })

  it('explicit workspacePath beats the IM default dir', () => {
    expect(resolveAgentCwd('claude-code', { ...FULL_IM_OPTS, workspacePath: '/tmp/portal-ws' }))
      .toBe('/tmp/portal-ws')
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

describe('resolveAgentWorkspaceRoot', () => {
  let tmpRoot: string
  let prevRoot: string | undefined
  let prevClaudeOverride: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'agim-wsroot-'))
    prevRoot = process.env.AGIM_WORKSPACES_ROOT
    prevClaudeOverride = process.env.AGIM_CLAUDE_CODE_CWD
    process.env.AGIM_WORKSPACES_ROOT = tmpRoot
    delete process.env.AGIM_CLAUDE_CODE_CWD
  })

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.AGIM_WORKSPACES_ROOT
    else process.env.AGIM_WORKSPACES_ROOT = prevRoot
    if (prevClaudeOverride === undefined) delete process.env.AGIM_CLAUDE_CODE_CWD
    else process.env.AGIM_CLAUDE_CODE_CWD = prevClaudeOverride
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('stays on the agent tree even when Portal binds a subdirectory cwd', () => {
    const selected = join(tmpRoot, 'claude-code', 'demo-proj')
    expect(resolveAgentCwd('claude-code', { ...FULL_IM_OPTS, workspacePath: selected }))
      .toBe(selected)
    expect(resolveAgentWorkspaceRoot('claude-code')).toBe(join(tmpRoot, 'claude-code'))
  })

  it('maps native to the agim tree', () => {
    expect(resolveAgentWorkspaceRoot('native')).toBe(join(tmpRoot, 'agim'))
    expect(resolveAgentWorkspaceRoot('agim')).toBe(join(tmpRoot, 'agim'))
  })

  it('maps a logged-in account to users/<id>/<agent>', () => {
    const root = runWithAccountUser('usr_abc123', () => resolveAgentWorkspaceRoot('agim'))
    expect(root).toBe(join(tmpRoot, 'users', 'usr_abc123', 'agim'))
    expect(resolveAgentWorkspaceRoot('agim', 'usr_abc123')).toBe(join(tmpRoot, 'users', 'usr_abc123', 'agim'))
  })

  it('honors AGIM_<AGENT>_CWD', () => {
    process.env.AGIM_CLAUDE_CODE_CWD = '/srv/explicit'
    expect(resolveAgentWorkspaceRoot('claude-code')).toBe('/srv/explicit')
  })
})

describe('buildPortalWorkspaceHint', () => {
  let prevRoot: string | undefined

  beforeEach(() => {
    prevRoot = process.env.AGIM_WORKSPACES_ROOT
    process.env.AGIM_WORKSPACES_ROOT = '/tmp/agim-workspaces-hint'
    delete process.env.AGIM_AGIM_CWD
  })

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.AGIM_WORKSPACES_ROOT
    else process.env.AGIM_WORKSPACES_ROOT = prevRoot
  })

  it('tells the agent to keep constraints at the workspace root', () => {
    const hint = buildPortalWorkspaceHint('agim', '/tmp/agim-workspaces-hint/agim/demo-proj')
    expect(hint).toContain('Working directory: `/tmp/agim-workspaces-hint/agim/demo-proj`')
    expect(hint).toContain('Workspace root: `/tmp/agim-workspaces-hint/agim`')
    expect(hint).toContain('MEMORY.md')
    expect(hint).toContain('AGENTS.md')
  })

  it('omits the root reminder when cwd is already the workspace root', () => {
    const hint = buildPortalWorkspaceHint('agim', '/tmp/agim-workspaces-hint/agim')
    expect(hint).toContain('Working directory: `/tmp/agim-workspaces-hint/agim`')
    expect(hint).not.toContain('Workspace root:')
  })

  it('names the account tree as workspace root for a logged-in user', () => {
    const hint = buildPortalWorkspaceHint(
      'agim',
      '/tmp/agim-workspaces-hint/users/usr_abc123/agim/demo-proj',
      'usr_abc123',
    )
    expect(hint).toContain('Workspace root: `/tmp/agim-workspaces-hint/users/usr_abc123/agim`')
    expect(hint).not.toContain('Workspace root: `/tmp/agim-workspaces-hint/agim`')
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
    expect(byAgent.agim).toBe(join(tmpRoot, 'agim'))
    expect(await readFile(join(tmpRoot, 'claude-code', 'CLAUDE.md'), 'utf8')).toContain('Claude Code')
    expect(await readFile(join(tmpRoot, 'opencode', 'AGENTS.md'), 'utf8')).toContain('OpenCode')
    expect(await readFile(join(tmpRoot, 'mimo', 'AGENTS.md'), 'utf8')).toContain('MiMo Code')
    expect(await readFile(join(tmpRoot, 'copilot', 'AGENTS.md'), 'utf8')).toContain('GitHub Copilot CLI')
    const agimGuide = await readFile(join(tmpRoot, 'agim', 'AGENTS.md'), 'utf8')
    expect(agimGuide).toContain('Agim Agent — 行为准则与操作约束')
    expect(agimGuide).toContain('## 说话规则')
    expect(agimGuide).toContain('## 任务执行规则（快、准、稳）')
    expect(agimGuide).toContain('## 对话逻辑')
    expect(agimGuide).toContain('platform=web|tui')
    expect(agimGuide).toContain('禁止')
    expect(agimGuide).toContain('直接执行，不要预告')
    expect(agimGuide).toContain('未收到结果不声称完成')
    expect(agimGuide).toContain(AGIM_IM_OPS_START)
    expect(agimGuide).toContain('## 长时间任务与 bgjob 后台执行')
    expect(agimGuide).toContain(`${AGIM_BGJOB_WRAPPER_EXPR} start`)
    expect(agimGuide).not.toMatch(/\/home\/[^/\s]+\/\.agim/)
    expect(agimGuide).toContain('强制使用 bgjob')
    expect(agimGuide).toContain(AGIM_MEMORY_LINK_START)
    // IM/bgjob baseline is shared across all agent workspaces.
    for (const [agent, file] of [
      ['claude-code', 'CLAUDE.md'],
      ['opencode', 'AGENTS.md'],
      ['codex', 'AGENTS.md'],
      ['mimo', 'AGENTS.md'],
      ['copilot', 'AGENTS.md'],
    ] as const) {
      const body = await readFile(join(tmpRoot, agent, file), 'utf8')
      expect(body).toContain(AGIM_MEMORY_LINK_START)
      expect(body).toContain(AGIM_IM_OPS_START)
      expect(body).toContain(AGIM_BGJOB_WRAPPER_EXPR)
      expect(body).toContain('强制使用 bgjob')
      expect(body).toContain('## 对话逻辑')
      expect(body).not.toMatch(/\/home\/[^/\s]+\/\.agim/)
    }
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

  it('appends managed IM/bgjob SOP into an existing Agim AGENTS.md without wiping persona', async () => {
    const dir = join(tmpRoot, 'agim')
    await ensureAgentWorkspace('agim', {
      filename: 'AGENTS.md',
      content: '# custom persona\n\n你是月魁。\n',
    })
    // ensureAgentWorkspace does not call the upsert — bootstrap / ensureAgimImOpsGuide does.
    await writeFile(join(dir, 'AGENTS.md'), '# custom persona\n\n你是月魁。\n', 'utf8')
    await ensureAgimImOpsGuide('agim')
    const content = await readFile(join(dir, 'AGENTS.md'), 'utf8')
    expect(content).toContain('你是月魁')
    expect(content).toContain(AGIM_IM_OPS_START)
    expect(content).toContain(`${AGIM_BGJOB_WRAPPER_EXPR} start`)
    expect(content.match(/agim:im-ops:start/g)?.length).toBe(1)
  })

  it('refreshes an existing managed IM/bgjob block on bootstrap for every agent', async () => {
    await bootstrapAgentWorkspaces()
    const path = join(tmpRoot, 'claude-code', 'CLAUDE.md')
    const stale = [
      '# keep me',
      '',
      AGIM_IM_OPS_START,
      '## stale block',
      'old bgjob advice',
      AGIM_IM_OPS_END,
      '',
      '## footer',
    ].join('\n')
    await writeFile(path, stale, 'utf8')
    await bootstrapAgentWorkspaces()
    const content = await readFile(path, 'utf8')
    expect(content).toContain('# keep me')
    expect(content).toContain('## footer')
    expect(content).toContain('## 长时间任务与 bgjob 后台执行')
    expect(content).toContain('强制使用 bgjob')
    expect(content).toContain('~/.agim-workspaces/claude-code/')
    expect(content).not.toContain('old bgjob advice')
    expect(content.match(/agim:im-ops:start/g)?.length).toBe(1)
  })

  it('does NOT wipe a customized Agim AGENTS.md when the packaged seed changes', async () => {
    await bootstrapAgentWorkspaces()
    const path = join(tmpRoot, 'agim', 'AGENTS.md')
    const customized = [
      '# my persona — keep forever',
      '',
      '你是月魁。',
      '',
      buildAgimImOpsBlock('agim'),
      '',
      '## custom footer',
    ].join('\n')
    await writeFile(path, customized, 'utf8')
    // Second bootstrap simulates a version upgrade that ships a new seed template.
    await bootstrapAgentWorkspaces()
    const content = await readFile(path, 'utf8')
    expect(content).toContain('# my persona — keep forever')
    expect(content).toContain('你是月魁')
    expect(content).toContain('## custom footer')
    expect(content).not.toContain('Agim Agent — 行为准则与操作约束')
  })

  it('skips im-ops refresh when freeze marker is present', async () => {
    await bootstrapAgentWorkspaces()
    const path = join(tmpRoot, 'agim', 'AGENTS.md')
    const frozen = [
      '# keep',
      AGIM_IM_OPS_FREEZE,
      AGIM_IM_OPS_START,
      '## operator-owned im-ops',
      'do not touch',
      AGIM_IM_OPS_END,
    ].join('\n')
    await writeFile(path, frozen, 'utf8')
    await ensureAgimImOpsGuide('agim')
    const content = await readFile(path, 'utf8')
    expect(content).toContain('## operator-owned im-ops')
    expect(content).toContain('do not touch')
    expect(content).not.toContain('强制使用 bgjob')
  })
})

describe('planImOpsUpsert', () => {
  afterEach(() => {
    delete process.env.AGIM_IM_OPS_REFRESH
  })

  it('skips write when managed block already matches (version-bump no-op)', () => {
    const block = buildAgimImOpsBlock('agim')
    const raw = `# persona\n\n${block}\n`
    expect(planImOpsUpsert(raw, block).kind).toBe('skip-unchanged')
  })

  it('im-ops baseline includes dialogue / Viewer rules for non-Agim agents', () => {
    const block = buildAgimImOpsBlock('opencode')
    expect(block).toContain('## 对话逻辑')
    expect(block).toContain('超过 8k')
    expect(block).toContain('Viewer')
    expect(block).toContain('platform=web|tui')
    expect(block).toContain('仅摘要')
    expect(block).toContain('强制使用 bgjob')
    expect(block).not.toContain('超长内容需拆成多条消息或写入文件后告知路径')
    expect(block).not.toContain('请控制长度')
  })

  it('Agim im-ops omits dialogue (lives outside markers in seed order)', () => {
    const block = buildAgimImOpsBlock('agim')
    expect(block).not.toContain('## 对话逻辑')
    expect(block).toContain('强制使用 bgjob')
  })

  it('plans a patch that preserves content outside markers', () => {
    const block = buildAgimImOpsBlock('opencode')
    const raw = [
      '# keep head',
      AGIM_IM_OPS_START,
      '## stale',
      AGIM_IM_OPS_END,
      '# keep tail',
    ].join('\n')
    const plan = planImOpsUpsert(raw, block)
    expect(plan.kind).toBe('patch')
    if (plan.kind !== 'patch') return
    expect(plan.next.startsWith('# keep head')).toBe(true)
    expect(plan.next.endsWith('# keep tail')).toBe(true)
    expect(plan.next).toContain('强制使用 bgjob')
    expect(plan.changedLines).toBeGreaterThan(0)
  })

  it('honours AGIM_IM_OPS_REFRESH=off', () => {
    process.env.AGIM_IM_OPS_REFRESH = 'off'
    const block = buildAgimImOpsBlock('agim')
    const raw = `# x\n${AGIM_IM_OPS_START}\nstale\n${AGIM_IM_OPS_END}\n`
    expect(planImOpsUpsert(raw, block).kind).toBe('skip-refresh-disabled')
  })
})
