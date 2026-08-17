import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGitDispatcher, getGitTools, isGitToolName, GIT_READ_SAFE } from './git-dispatcher.js'
import { runCmd } from './run-cmd.js'

const NEVER = new AbortController().signal

describe('git-dispatcher', () => {
  let repo: string

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'agim-git-'))
    await runCmd('git', ['init'], { cwd: repo, timeoutMs: 10_000 })
    await runCmd('git', ['config', 'user.email', 'test@agim.local'], { cwd: repo })
    await runCmd('git', ['config', 'user.name', 'Agim Test'], { cwd: repo })
    await writeFile(join(repo, 'a.txt'), 'hello\n')
    await runCmd('git', ['add', 'a.txt'], { cwd: repo })
    await runCmd('git', ['commit', '-m', 'init'], { cwd: repo })
  })

  afterAll(async () => {
    try { await rm(repo, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('advertises read + write tools', () => {
    const names = getGitTools().map((t) => t.name).sort()
    expect(names).toEqual([
      'agim_git_add',
      'agim_git_commit',
      'agim_git_diff',
      'agim_git_log',
      'agim_git_status',
    ])
    expect(isGitToolName('agim_git_status')).toBe(true)
    expect(GIT_READ_SAFE.has('agim_git_status')).toBe(true)
    expect(GIT_READ_SAFE.has('agim_git_commit')).toBe(false)
  })

  it('status / log / diff on a clean repo', async () => {
    const d = buildGitDispatcher({ cwd: repo })
    const st = await d({ id: '1', name: 'agim_git_status', arguments: {} }, NEVER)
    expect(st.isError).toBe(false)
    expect(st.text).toMatch(/##/)

    const log = await d({ id: '2', name: 'agim_git_log', arguments: { max: 5 } }, NEVER)
    expect(log.isError).toBe(false)
    expect(log.text).toMatch(/init/)

    const diff = await d({ id: '3', name: 'agim_git_diff', arguments: {} }, NEVER)
    expect(diff.isError).toBe(false)
  })

  it('add + commit a change', async () => {
    await writeFile(join(repo, 'b.txt'), 'world\n')
    const d = buildGitDispatcher({ cwd: repo })
    const add = await d(
      { id: 'a', name: 'agim_git_add', arguments: { paths: ['b.txt'] } },
      NEVER,
    )
    expect(add.isError).toBe(false)
    const commit = await d(
      { id: 'c', name: 'agim_git_commit', arguments: { message: 'feat: add b' } },
      NEVER,
    )
    expect(commit.isError).toBe(false)
    const log = await d({ id: 'l', name: 'agim_git_log', arguments: { max: 3 } }, NEVER)
    expect(log.text).toMatch(/feat: add b/)
  })

  it('refuses empty commit message and flag-like add paths', async () => {
    const d = buildGitDispatcher({ cwd: repo })
    const badMsg = await d(
      { id: '1', name: 'agim_git_commit', arguments: { message: '  ' } },
      NEVER,
    )
    expect(badMsg.isError).toBe(true)
    const badAdd = await d(
      { id: '2', name: 'agim_git_add', arguments: { paths: ['--all'] } },
      NEVER,
    )
    expect(badAdd.isError).toBe(true)
  })

  it('errors outside a git repo', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'agim-nogit-'))
    try {
      await mkdir(join(bare, 'sub'), { recursive: true })
      const d = buildGitDispatcher({ cwd: bare })
      const st = await d({ id: '1', name: 'agim_git_status', arguments: {} }, NEVER)
      expect(st.isError).toBe(true)
      expect(st.text).toMatch(/not a git repository/i)
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})
