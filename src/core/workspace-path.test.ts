import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePortalWorkspacePath } from './workspace-path.js'

describe('resolvePortalWorkspacePath', () => {
  it('resolves an existing absolute directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agim-ws-'))
    try {
      expect(resolvePortalWorkspacePath(dir)).toBe(realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a bare folder name under process.cwd()', () => {
    const name = `ws-rel-${Date.now().toString(36)}`
    const dir = join(process.cwd(), name)
    mkdirSync(dir)
    try {
      expect(resolvePortalWorkspacePath(name)).toBe(realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects missing paths, files, and parent traversal', () => {
    expect(resolvePortalWorkspacePath('')).toBeUndefined()
    expect(resolvePortalWorkspacePath('../etc')).toBeUndefined()
    expect(resolvePortalWorkspacePath('/no/such/agim-ws-dir')).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'agim-ws-file-'))
    const file = join(dir, 'only.txt')
    writeFileSync(file, 'x')
    try {
      expect(resolvePortalWorkspacePath(file)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
