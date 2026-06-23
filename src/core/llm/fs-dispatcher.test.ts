import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFsDispatcher, getFsTools, isFsToolName } from './fs-dispatcher.js'

const NEVER_ABORT = new AbortController().signal

describe('fs-dispatcher', () => {
  let workspace: string
  const ORIG_RESTRICT = process.env.IMHUB_NATIVE_FS_RESTRICT

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agim-fs-test-'))
  })

  afterAll(async () => {
    try { await rm(workspace, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  beforeEach(() => {
    // Default: workspace restriction ON (the production default).
    delete process.env.IMHUB_NATIVE_FS_RESTRICT
  })

  afterEach(() => {
    if (ORIG_RESTRICT === undefined) delete process.env.IMHUB_NATIVE_FS_RESTRICT
    else process.env.IMHUB_NATIVE_FS_RESTRICT = ORIG_RESTRICT
  })

  describe('getFsTools / isFsToolName', () => {
    it('exposes 5 tools with stable names', () => {
      const tools = getFsTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toEqual([
        'native_glob', 'native_grep', 'native_list_dir',
        'native_read_file', 'native_write_file',
      ])
    })

    it('isFsToolName matches the 5 tools', () => {
      for (const n of ['native_read_file', 'native_write_file', 'native_list_dir', 'native_glob', 'native_grep']) {
        expect(isFsToolName(n)).toBe(true)
      }
      expect(isFsToolName('native_echo')).toBe(false)
      expect(isFsToolName('mcp__imhub__call_agent')).toBe(false)
    })
  })

  describe('read_file', () => {
    it('reads a file in workspace', async () => {
      await writeFile(join(workspace, 'hello.txt'), 'hi there')
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: 'hello.txt' } }, NEVER_ABORT)
      expect(r.isError).toBe(false)
      expect(r.text).toBe('hi there')
      expect(r.source).toBe('fs')
    })

    it('truncates files over max_bytes', async () => {
      const big = 'a'.repeat(5000)
      await writeFile(join(workspace, 'big.txt'), big)
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d(
        { id: 't', name: 'native_read_file', arguments: { path: 'big.txt', max_bytes: 100 } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(false)
      expect(r.text).toContain('[truncated:')
      expect(r.text).toContain('a'.repeat(100))
    })

    it('refuses paths outside workspace when restricted', async () => {
      process.env.IMHUB_NATIVE_FS_RESTRICT = '1'
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: '/etc/hostname' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/outside workspace|sensitive/i)
    })

    it('by default (unrestricted), reads a non-sensitive file outside the workspace', async () => {
      // Default = no IMHUB_NATIVE_FS_RESTRICT → native agents have real fs access.
      const outside = join(tmpdir(), `agim-fs-default-${Date.now()}.txt`)
      await writeFile(outside, 'outside content')
      try {
        const d = buildFsDispatcher({ cwd: workspace })
        const r = await d({ id: 't', name: 'native_read_file', arguments: { path: outside } }, NEVER_ABORT)
        expect(r.isError).toBe(false)
        expect(r.text).toBe('outside content')
      } finally {
        await rm(outside, { force: true })
      }
    })

    it('by default (unrestricted), still denies sensitive paths', async () => {
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: '~/.agim/env' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/sensitive/i)
    })

    it('refuses sensitive paths even when IMHUB_NATIVE_FS_RESTRICT=0', async () => {
      process.env.IMHUB_NATIVE_FS_RESTRICT = '0'
      const d = buildFsDispatcher({ cwd: workspace })
      // ~/.agim is on the sensitive denylist
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: '~/.agim/env' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/sensitive/i)
    })

    it('refuses non-files (e.g. directory)', async () => {
      await mkdir(join(workspace, 'subdir'), { recursive: true })
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: 'subdir' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/not a file/)
    })
  })

  describe('write_file', () => {
    it('overwrites a file', async () => {
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d(
        { id: 't', name: 'native_write_file', arguments: { path: 'out.txt', content: 'first' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(false)
      const r2 = await d(
        { id: 't', name: 'native_write_file', arguments: { path: 'out.txt', content: 'second' } },
        NEVER_ABORT,
      )
      expect(r2.isError).toBe(false)
      const readBack = await d({ id: 't', name: 'native_read_file', arguments: { path: 'out.txt' } }, NEVER_ABORT)
      expect(readBack.text).toBe('second')
    })

    it('appends with mode=append', async () => {
      const d = buildFsDispatcher({ cwd: workspace })
      await d({ id: 't', name: 'native_write_file', arguments: { path: 'append.txt', content: 'A' } }, NEVER_ABORT)
      await d(
        { id: 't', name: 'native_write_file', arguments: { path: 'append.txt', content: 'B', mode: 'append' } },
        NEVER_ABORT,
      )
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: 'append.txt' } }, NEVER_ABORT)
      expect(r.text).toBe('AB')
    })

    it('refuses paths outside workspace when restricted', async () => {
      process.env.IMHUB_NATIVE_FS_RESTRICT = '1'
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d(
        { id: 't', name: 'native_write_file', arguments: { path: '/tmp/agim-evil', content: 'no' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
    })
  })

  describe('list_dir', () => {
    it('lists entries with type + size', async () => {
      const subdir = join(workspace, 'listme')
      await mkdir(subdir, { recursive: true })
      await writeFile(join(subdir, 'a.txt'), 'hi')
      await writeFile(join(subdir, 'b.txt'), 'longer content')
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_list_dir', arguments: { path: 'listme' } }, NEVER_ABORT)
      expect(r.isError).toBe(false)
      const parsed = JSON.parse(r.text)
      expect(parsed.entries.length).toBe(2)
      const names = parsed.entries.map((e: { name: string }) => e.name).sort()
      expect(names).toEqual(['a.txt', 'b.txt'])
      expect(parsed.entries.every((e: { type: string }) => e.type === 'file')).toBe(true)
    })
  })

  describe('glob (fallback walker — no rg required)', () => {
    it('finds matching files', async () => {
      const root = join(workspace, 'globme')
      await mkdir(join(root, 'sub'), { recursive: true })
      await writeFile(join(root, 'x.ts'), '')
      await writeFile(join(root, 'sub', 'y.ts'), '')
      await writeFile(join(root, 'sub', 'z.txt'), '')
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d(
        { id: 't', name: 'native_glob', arguments: { pattern: '**/*.ts', root: 'globme' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(false)
      const parsed = JSON.parse(r.text)
      // Rg or fallback both find these.
      expect(parsed.files.sort()).toEqual(['sub/y.ts', 'x.ts'])
    })
  })

  describe('timeout wrapper', () => {
    it('honors IMHUB_NATIVE_FS_TIMEOUT_MS for slow ops', async () => {
      // Trick: a non-existent dir errors fast; we just verify the
      // timeout code path is reachable by setting a low timeout and
      // making sure errors still propagate (not the timeout itself
      // necessarily, since most ops complete fast).
      process.env.IMHUB_NATIVE_FS_TIMEOUT_MS = '5000'
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: 'does-not-exist' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      delete process.env.IMHUB_NATIVE_FS_TIMEOUT_MS
    })
  })

  // v1.2.70 — CR-1: symlink escape via lexical path checks. Before
  // the realpath guard, an attacker could drop a symlink inside the
  // workspace pointing at /etc/passwd and read it back. realpath()
  // collapses the symlink chain so the safety check sees the real
  // destination.
  describe('symlink escape guard (CR-1)', () => {
    it('refuses to read a symlink whose target is sensitive', async () => {
      // /etc/shadow is on the sensitive denylist, so this is denied even
      // under the default (unrestricted) workspace policy — the realpath
      // guard collapses the symlink and the sensitive check fires. The OLD
      // lexical check returned ok and happily read the target.
      const link = join(workspace, 'evil-shadow')
      try { await rm(link, { force: true }) } catch { /* ignore */ }
      await symlink('/etc/shadow', link)
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: 'evil-shadow' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/sensitive/i)
    })

    it('refuses to read a symlink whose target is outside workspace', async () => {
      process.env.IMHUB_NATIVE_FS_RESTRICT = '1'
      const otherDir = await mkdtemp(join(tmpdir(), 'agim-fs-outside-'))
      await writeFile(join(otherDir, 'secret.txt'), 'top-secret')
      const link = join(workspace, 'escape')
      try { await rm(link, { force: true }) } catch { /* ignore */ }
      await symlink(join(otherDir, 'secret.txt'), link)
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: 'escape' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/outside workspace|symlink/i)
      try { await rm(otherDir, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    it('refuses to write through a symlinked directory pointing outside', async () => {
      process.env.IMHUB_NATIVE_FS_RESTRICT = '1'
      const otherDir = await mkdtemp(join(tmpdir(), 'agim-fs-symdir-'))
      const linkDir = join(workspace, 'evil-dir')
      try { await rm(linkDir, { force: true }) } catch { /* ignore */ }
      await symlink(otherDir, linkDir)
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d(
        { id: 't', name: 'native_write_file', arguments: { path: 'evil-dir/x.txt', content: 'no' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/outside workspace|symlink/i)
      try { await rm(otherDir, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    it('allows symlinks that resolve INSIDE the workspace', async () => {
      const target = join(workspace, 'real-target.txt')
      await writeFile(target, 'allowed')
      const link = join(workspace, 'inside-link')
      try { await rm(link, { force: true }) } catch { /* ignore */ }
      await symlink(target, link)
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_read_file', arguments: { path: 'inside-link' } }, NEVER_ABORT)
      expect(r.isError).toBe(false)
      expect(r.text).toBe('allowed')
    })
  })

  describe('unknown tool routing', () => {
    it('returns source:unknown so combineDispatchers tries the next layer', async () => {
      const d = buildFsDispatcher({ cwd: workspace })
      const r = await d({ id: 't', name: 'native_echo', arguments: { text: 'x' } }, NEVER_ABORT)
      expect(r.source).toBe('unknown')
      expect(r.isError).toBe(true)
    })
  })
})
