import { describe, expect, it, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'agim-skills-disabled-'))
const wsRoot = mkdtempSync(join(tmpdir(), 'agim-skills-disabled-ws-'))
const builtinRoot = mkdtempSync(join(tmpdir(), 'agim-skills-disabled-bi-'))
process.env.AGIM_HOME = HOME
process.env.AGIM_SKILLS_WORKSPACE_DIR = wsRoot
process.env.AGIM_SKILLS_BUILTIN_DIR = builtinRoot
process.env.AGIM_SKILLS_MODE = 'agim-only'

const { isSkillEnabled, setSkillEnabled, listDisabledSkillNames } = await import('./disabled-set.js')
const { buildSkillsSummary, invalidateSkillsCache, listSkills } = await import('./loader.js')
const { runWithAccountUser } = await import('../accounts.js')

function writeSkill(name: string, description: string): void {
  const dir = join(wsRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---
name: ${name}
description: ${description}
---

body
`, 'utf-8')
}

beforeEach(() => {
  rmSync(wsRoot, { recursive: true, force: true })
  mkdirSync(wsRoot, { recursive: true })
  rmSync(join(HOME, 'skills-disabled.json'), { force: true })
  rmSync(join(HOME, 'users'), { recursive: true, force: true })
  invalidateSkillsCache()
})

afterAll(() => {
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(wsRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(builtinRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('disabled skill set', () => {
  it('defaults to enabled and persists a disable', () => {
    expect(isSkillEnabled('demo')).toBe(true)
    expect(setSkillEnabled('demo', false)).toBe(false)
    expect(isSkillEnabled('Demo')).toBe(false)
    expect(listDisabledSkillNames()).toContain('demo')
    setSkillEnabled('demo', true)
    expect(isSkillEnabled('demo')).toBe(true)
    expect(listDisabledSkillNames()).toEqual([])
  })

  it('scopes the file to the ALS account', () => {
    runWithAccountUser('usr_aaaa', () => setSkillEnabled('alpha', false))
    expect(isSkillEnabled('alpha')).toBe(true)
    runWithAccountUser('usr_aaaa', () => {
      expect(isSkillEnabled('alpha')).toBe(false)
    })
    runWithAccountUser('usr_bbbb', () => {
      expect(isSkillEnabled('alpha')).toBe(true)
    })
  })

  it('drops disabled skills from the injection summary', () => {
    writeSkill('keep-me', 'kept skill')
    writeSkill('drop-me', 'dropped skill')
    invalidateSkillsCache()
    expect(listSkills().map((s) => s.name).sort()).toEqual(['drop-me', 'keep-me'])
    const before = buildSkillsSummary()
    expect(before).toContain('keep-me')
    expect(before).toContain('drop-me')
    setSkillEnabled('drop-me', false)
    const after = buildSkillsSummary()
    expect(after).toContain('keep-me')
    expect(after).not.toContain('drop-me')
  })
})
