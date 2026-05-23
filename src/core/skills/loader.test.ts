// Unit tests for the skills loader (Stage 3 / P0 #3).
//
// We set IMHUB_SKILLS_WORKSPACE_DIR + IMHUB_SKILLS_BUILTIN_DIR to two
// temp dirs that we populate per-test, then call the loader's public
// API. The loader caches scans by default; we call invalidateSkillsCache
// after every fixture rebuild.

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listSkills, getSkillByName, readSkillBody, buildSkillsSummary,
  invalidateSkillsCache,
  MAX_INJECTED_SKILLS, MAX_DESCRIPTION_CHARS,
} from './loader.js'
import { handleSkillsOp } from '../skills-rpc.js'

const wsRoot = mkdtempSync(join(tmpdir(), 'agim-skills-ws-'))
const builtinRoot = mkdtempSync(join(tmpdir(), 'agim-skills-builtin-'))

process.env.IMHUB_SKILLS_WORKSPACE_DIR = wsRoot
process.env.IMHUB_SKILLS_BUILTIN_DIR = builtinRoot

afterAll(() => {
  try { rmSync(wsRoot, { recursive: true, force: true }) } catch {}
  try { rmSync(builtinRoot, { recursive: true, force: true }) } catch {}
})

function writeSkill(root: string, name: string, body: string): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8')
}

function resetDirs(): void {
  rmSync(wsRoot, { recursive: true, force: true })
  rmSync(builtinRoot, { recursive: true, force: true })
  mkdirSync(wsRoot, { recursive: true })
  mkdirSync(builtinRoot, { recursive: true })
  invalidateSkillsCache()
}

beforeEach(() => {
  resetDirs()
})

describe('skills loader — discovery', () => {
  it('returns empty when neither dir has skills', () => {
    expect(listSkills()).toEqual([])
  })

  it('discovers a workspace skill with minimal frontmatter', () => {
    writeSkill(wsRoot, 'demo', `---
name: demo
description: a tiny demo skill for testing
---

body here.
`)
    const skills = listSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('demo')
    expect(skills[0].description).toBe('a tiny demo skill for testing')
    expect(skills[0].source).toBe('workspace')
    expect(skills[0].always).toBe(false)
    expect(skills[0].available).toBe(true)
  })

  it('discovers a builtin skill', () => {
    writeSkill(builtinRoot, 'builtin1', `---
name: builtin1
description: bundled skill
---

body
`)
    const skills = listSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].source).toBe('builtin')
  })

  it('workspace shadows builtin with the same name', () => {
    writeSkill(builtinRoot, 'shared', `---
name: shared
description: the builtin one
---

builtin body
`)
    writeSkill(wsRoot, 'shared', `---
name: shared
description: the workspace one
---

workspace body
`)
    const skills = listSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].source).toBe('workspace')
    expect(skills[0].description).toBe('the workspace one')
  })

  it('rejects skill without frontmatter (warn + skip)', () => {
    writeSkill(wsRoot, 'no-front', 'just a body, no fence.\n')
    expect(listSkills()).toHaveLength(0)
  })

  it('rejects skill with empty description (warn + skip)', () => {
    writeSkill(wsRoot, 'no-desc', `---
name: no-desc
---

body
`)
    expect(listSkills()).toHaveLength(0)
  })

  it('truncates oversize description', () => {
    const longDesc = 'x'.repeat(MAX_DESCRIPTION_CHARS + 100)
    writeSkill(wsRoot, 'long', `---
name: long
description: "${longDesc}"
---

body
`)
    const s = listSkills()[0]
    expect(s.description.length).toBe(MAX_DESCRIPTION_CHARS)
  })
})

describe('skills loader — requires checking', () => {
  it('marks unavailable when a required bin is missing', () => {
    writeSkill(wsRoot, 'needs-bin', `---
name: needs-bin
description: needs a fictitious binary
metadata: '{"agim":{"requires":{"bins":["definitely-not-real-binary-xyz123"]}}}'
---

body
`)
    const s = listSkills()[0]
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toContain('definitely-not-real-binary-xyz123')
  })

  it('marks unavailable when required env is empty', () => {
    delete process.env.SKILLS_TEST_REQ_FAKE
    writeSkill(wsRoot, 'needs-env', `---
name: needs-env
description: needs a fictitious env var
metadata: '{"agim":{"requires":{"env":["SKILLS_TEST_REQ_FAKE"]}}}'
---

body
`)
    const s = listSkills()[0]
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toContain('SKILLS_TEST_REQ_FAKE')
  })

  it('marks available when env is set', () => {
    process.env.SKILLS_TEST_REQ_FAKE = '1'
    writeSkill(wsRoot, 'has-env', `---
name: has-env
description: has the env we need
metadata: '{"agim":{"requires":{"env":["SKILLS_TEST_REQ_FAKE"]}}}'
---

body
`)
    const s = listSkills()[0]
    expect(s.available).toBe(true)
    delete process.env.SKILLS_TEST_REQ_FAKE
  })

  it('accepts the nanobot-compat "openclaw" metadata key', () => {
    delete process.env.NANO_FAKE
    writeSkill(wsRoot, 'nano-compat', `---
name: nano-compat
description: written for nanobot, reused by agim
metadata: '{"openclaw":{"requires":{"env":["NANO_FAKE"]}}}'
---

body
`)
    const s = listSkills()[0]
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toContain('NANO_FAKE')
  })
})

describe('buildSkillsSummary', () => {
  it('returns empty string when no skills', () => {
    expect(buildSkillsSummary()).toBe('')
  })

  it('contains every skill name + description', () => {
    writeSkill(wsRoot, 'one', `---
name: one
description: first skill
---
body
`)
    writeSkill(wsRoot, 'two', `---
name: two
description: second skill
---
body
`)
    const out = buildSkillsSummary()
    expect(out).toContain('one: first skill')
    expect(out).toContain('two: second skill')
    expect(out).toContain('read_skill')
  })

  it('marks unavailable skills inline', () => {
    writeSkill(wsRoot, 'broken', `---
name: broken
description: needs a missing bin
metadata: '{"agim":{"requires":{"bins":["bogus-binary-zzz"]}}}'
---
body
`)
    const out = buildSkillsSummary()
    expect(out).toContain('unavailable')
    expect(out).toContain('bogus-binary-zzz')
  })

  it('inlines always:true skill bodies', () => {
    writeSkill(wsRoot, 'always-on', `---
name: always-on
description: always-injected body
always: true
---

This text MUST appear inline.
`)
    const out = buildSkillsSummary()
    expect(out).toContain('Always-on skill: always-on')
    expect(out).toContain('This text MUST appear inline.')
  })

  it('caps at MAX_INJECTED_SKILLS with overflow notice', () => {
    for (let i = 0; i < MAX_INJECTED_SKILLS + 3; i++) {
      writeSkill(wsRoot, `s${String(i).padStart(3, '0')}`, `---
name: s${String(i).padStart(3, '0')}
description: skill number ${i}
---
body
`)
    }
    const out = buildSkillsSummary()
    expect(out).toContain('and 3 more')
  })
})

describe('readSkillBody', () => {
  it('returns the full body for a known skill', () => {
    writeSkill(wsRoot, 'with-body', `---
name: with-body
description: has body
---

PARAGRAPH ONE.

PARAGRAPH TWO.
`)
    const body = readSkillBody('with-body')
    expect(body).toContain('PARAGRAPH ONE.')
    expect(body).toContain('PARAGRAPH TWO.')
  })

  it('case-insensitive lookup', () => {
    writeSkill(wsRoot, 'CaseSensitive', `---
name: CaseSensitive
description: mixed case
---
body
`)
    expect(readSkillBody('casesensitive')).not.toBeNull()
    expect(readSkillBody('CASESENSITIVE')).not.toBeNull()
  })

  it('returns null for unknown skill', () => {
    expect(readSkillBody('does-not-exist')).toBeNull()
  })
})

describe('handleSkillsOp (RPC)', () => {
  it('op:read returns full body', async () => {
    writeSkill(wsRoot, 'rpc-demo', `---
name: rpc-demo
description: demo for rpc
---

RPC BODY MARKER
`)
    const r = await handleSkillsOp({ op: 'read', name: 'rpc-demo' })
    expect(r.ok).toBe(true)
    if (r.ok && r.result.op === 'read') {
      expect(r.result.body).toContain('RPC BODY MARKER')
      expect(r.result.available).toBe(true)
    }
  })

  it('op:read rejects missing name', async () => {
    const r = await handleSkillsOp({ op: 'read' })
    expect(r.ok).toBe(false)
  })

  it('op:read returns error on unknown skill', async () => {
    const r = await handleSkillsOp({ op: 'read', name: 'no-such' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('unknown skill')
  })

  it('op:list returns every skill name', async () => {
    writeSkill(wsRoot, 'l1', `---
name: l1
description: x
---
body
`)
    writeSkill(wsRoot, 'l2', `---
name: l2
description: x
---
body
`)
    invalidateSkillsCache()
    const r = await handleSkillsOp({ op: 'list' })
    expect(r.ok).toBe(true)
    if (r.ok && r.result.op === 'list') {
      const names = r.result.skills.map((s) => s.name).sort()
      expect(names).toEqual(['l1', 'l2'])
    }
  })

  it('op:refresh resets the cache', async () => {
    writeSkill(wsRoot, 'before', `---
name: before
description: x
---
body
`)
    invalidateSkillsCache()
    expect(listSkills()).toHaveLength(1)

    // Drop a fresh skill on disk WITHOUT manually invalidating.
    writeSkill(wsRoot, 'after', `---
name: after
description: y
---
body
`)
    // listSkills still cached → still 1
    expect(listSkills()).toHaveLength(1)

    const r = await handleSkillsOp({ op: 'refresh' })
    expect(r.ok).toBe(true)
    if (r.ok && r.result.op === 'refresh') {
      expect(r.result.total).toBe(2)
    }
    expect(listSkills()).toHaveLength(2)
  })

  it('rejects unknown op', async () => {
    const r = await handleSkillsOp({ op: 'demolish' })
    expect(r.ok).toBe(false)
  })
})

describe('getSkillByName', () => {
  it('returns the meta or null', () => {
    writeSkill(wsRoot, 'find-me', `---
name: find-me
description: present
---
body
`)
    expect(getSkillByName('find-me')?.name).toBe('find-me')
    expect(getSkillByName('FIND-ME')?.name).toBe('find-me')
    expect(getSkillByName('not-here')).toBeNull()
  })
})
