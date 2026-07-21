import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agimBgjobScript,
  agimBgjobsDir,
  bgjobAllowedPaths,
  ensureBgjobInstalled,
} from './bgjob-install.js'

describe('bgjob-install', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('resolves script + data dirs under AGIM_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'agim-bgjob-home-'))
    dirs.push(home)
    expect(agimBgjobScript(home)).toBe(join(home, 'scripts', 'bgjob'))
    expect(agimBgjobsDir(home)).toBe(join(home, 'bgjobs'))
  })

  it('lists Agim path first among allowed carve-out paths', () => {
    const paths = bgjobAllowedPaths()
    expect(paths[0]).toBe(agimBgjobScript())
    expect(paths.some((p) => p.endsWith('/.claude/scripts/bgjob'))).toBe(true)
  })

  it('copies packaged bgjob + agim_rpc.py into ~/.agim/scripts', () => {
    const home = mkdtempSync(join(tmpdir(), 'agim-bgjob-install-'))
    dirs.push(home)
    const dest = ensureBgjobInstalled(home)
    expect(dest).toBe(join(home, 'scripts', 'bgjob'))
    expect(existsSync(dest!)).toBe(true)
    expect(existsSync(join(home, 'scripts', 'agim_rpc.py'))).toBe(true)
    expect(existsSync(join(home, 'bgjobs'))).toBe(true)
    expect(readFileSync(dest!, 'utf8')).toContain('agim bgjob')
  })

  it('is idempotent and refreshes a stale installed copy', () => {
    const home = mkdtempSync(join(tmpdir(), 'agim-bgjob-refresh-'))
    dirs.push(home)
    mkdirSync(join(home, 'scripts'), { recursive: true })
    const dest = join(home, 'scripts', 'bgjob')
    writeFileSync(dest, '#!/bin/sh\necho stale\n', 'utf8')
    chmodSync(dest, 0o755)
    ensureBgjobInstalled(home)
    const body = readFileSync(dest, 'utf8')
    expect(body).toContain('agim bgjob')
    expect(body).not.toContain('echo stale')
  })
})
