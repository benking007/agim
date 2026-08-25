import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePortalWorkspacePath } from './workspace-path.js'

const prevRoot = process.env.AGIM_WORKSPACES_ROOT

function withAgentTree(): { root: string; agentRoot: string; child: string; nested: string } {
  const root = mkdtempSync(join(tmpdir(), 'agim-ws-root-'))
  process.env.AGIM_WORKSPACES_ROOT = root
  const agentRoot = join(root, 'agim')
  const child = join(agentRoot, 'proj')
  const nested = join(child, 'src')
  mkdirSync(nested, { recursive: true })
  mkdirSync(join(root, 'claude-code', 'other'), { recursive: true })
  return { root, agentRoot, child, nested }
}

afterEach(() => {
  if (prevRoot === undefined) delete process.env.AGIM_WORKSPACES_ROOT
  else process.env.AGIM_WORKSPACES_ROOT = prevRoot
})

describe('resolvePortalWorkspacePath', () => {
  it('resolves a relative subdirectory under the agent workspace', () => {
    const { root, child } = withAgentTree()
    try {
      expect(resolvePortalWorkspacePath('proj', 'agim')).toBe(realpathSync(child))
      expect(resolvePortalWorkspacePath('proj/src', 'agim')).toBe(realpathSync(join(child, 'src')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves an absolute path that already lives under the agent workspace', () => {
    const { root, child } = withAgentTree()
    try {
      expect(resolvePortalWorkspacePath(child, 'agim')).toBe(realpathSync(child))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects the agent workspace root itself', () => {
    const { root, agentRoot } = withAgentTree()
    try {
      expect(resolvePortalWorkspacePath(agentRoot, 'agim')).toBeUndefined()
      expect(resolvePortalWorkspacePath('.', 'agim')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects paths outside the agent workspace', () => {
    const { root } = withAgentTree()
    const outside = mkdtempSync(join(tmpdir(), 'agim-ws-out-'))
    try {
      expect(resolvePortalWorkspacePath(outside, 'agim')).toBeUndefined()
      expect(resolvePortalWorkspacePath('/etc', 'agim')).toBeUndefined()
      expect(resolvePortalWorkspacePath('../claude-code/other', 'agim')).toBeUndefined()
      expect(resolvePortalWorkspacePath(join(root, 'claude-code', 'other'), 'agim')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects missing paths, files, traversal, and a missing agent', () => {
    const { root, child } = withAgentTree()
    const file = join(child, 'only.txt')
    writeFileSync(file, 'x')
    try {
      expect(resolvePortalWorkspacePath('', 'agim')).toBeUndefined()
      expect(resolvePortalWorkspacePath('proj', '')).toBeUndefined()
      expect(resolvePortalWorkspacePath('no-such-dir', 'agim')).toBeUndefined()
      expect(resolvePortalWorkspacePath(file, 'agim')).toBeUndefined()
      expect(resolvePortalWorkspacePath('proj/../..', 'agim')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves named folders under the account tree and rejects the shared tree', () => {
    const { root } = withAgentTree()
    const accountChild = join(root, 'users', 'usr_abc123', 'agim', 'proj')
    mkdirSync(accountChild, { recursive: true })
    try {
      expect(resolvePortalWorkspacePath('proj', 'agim', 'usr_abc123'))
        .toBe(realpathSync(accountChild))
      expect(resolvePortalWorkspacePath(join(root, 'agim', 'proj'), 'agim', 'usr_abc123'))
        .toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
