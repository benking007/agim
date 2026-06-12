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
// Pin discovery to the temp workspace only — the multi-root 'auto'
// default would otherwise inherit ~/.claude/skills + opencode/codex
// dirs on the dev box and break the per-test fixture counts.
process.env.IMHUB_SKILLS_MODE = 'agim-only'

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

  // v1.2.137 — skills-first routing discipline. The block now prefixes
  // the list with a MUST rule telling every agent to scan skills before
  // generic tools (web_fetch / web_search / native_exec). One injection
  // point, applies to native + all CLI adapters because router.ts wraps
  // this string into every turn's prompt.
  describe('v1.2.137 routing rule', () => {
    it('prepends the skills-first MUST rule when at least one skill exists', () => {
      writeSkill(wsRoot, 'sample', `---
name: sample
description: any skill
---
body
`)
      const out = buildSkillsSummary()
      // The rule's signature phrases — assertions are intentionally
      // narrow so prose-level tweaks don't fail the test, but the
      // critical behavioural directives do.
      expect(out).toContain('[agim tool routing — skills first]')
      expect(out).toContain('MUST scan the skill list')
      expect(out).toContain('mcp__imhub__read_skill')
      // Rule must come before the listing header so models process it
      // first when reading top-down.
      const ruleIdx = out.indexOf('[agim tool routing — skills first]')
      const listIdx = out.indexOf('[agim skills available')
      expect(ruleIdx).toBeGreaterThanOrEqual(0)
      expect(listIdx).toBeGreaterThan(ruleIdx)
    })

    it('does NOT inject the rule when no skills are configured', () => {
      // Default: empty workspace, no skills.
      expect(buildSkillsSummary()).toBe('')
    })
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

describe('skills loader — multi-root discovery', () => {
  it('custom mode honors IMHUB_SKILLS_ROOTS (workspace always prepended)', async () => {
    const extraRoot = mkdtempSync(join(tmpdir(), 'agim-skills-extra-'))
    try {
      writeSkill(extraRoot, 'from-extra', `---
name: from-extra
description: lives in the extra root
---
body
`)
      writeSkill(wsRoot, 'from-ws', `---
name: from-ws
description: lives in the workspace
---
body
`)
      const prevMode = process.env.IMHUB_SKILLS_MODE
      const prevRoots = process.env.IMHUB_SKILLS_ROOTS
      process.env.IMHUB_SKILLS_MODE = 'custom'
      process.env.IMHUB_SKILLS_ROOTS = extraRoot
      invalidateSkillsCache()
      try {
        const names = listSkills().map((s) => s.name).sort()
        expect(names).toEqual(['from-extra', 'from-ws'])
      } finally {
        process.env.IMHUB_SKILLS_MODE = prevMode
        process.env.IMHUB_SKILLS_ROOTS = prevRoots
        invalidateSkillsCache()
      }
    } finally {
      try { rmSync(extraRoot, { recursive: true, force: true }) } catch {}
    }
  })

  it('workspace shadows same-named entry in inherited root', async () => {
    const extraRoot = mkdtempSync(join(tmpdir(), 'agim-skills-extra-'))
    try {
      writeSkill(extraRoot, 'shared', `---
name: shared
description: extra-root version
---
body
`)
      writeSkill(wsRoot, 'shared', `---
name: shared
description: workspace wins
---
body
`)
      const prevMode = process.env.IMHUB_SKILLS_MODE
      const prevRoots = process.env.IMHUB_SKILLS_ROOTS
      process.env.IMHUB_SKILLS_MODE = 'custom'
      process.env.IMHUB_SKILLS_ROOTS = extraRoot
      invalidateSkillsCache()
      try {
        const skills = listSkills()
        expect(skills).toHaveLength(1)
        expect(skills[0].description).toBe('workspace wins')
        expect(skills[0].dir.startsWith(wsRoot)).toBe(true)
      } finally {
        process.env.IMHUB_SKILLS_MODE = prevMode
        process.env.IMHUB_SKILLS_ROOTS = prevRoots
        invalidateSkillsCache()
      }
    } finally {
      try { rmSync(extraRoot, { recursive: true, force: true }) } catch {}
    }
  })

  it('describeSkillsConfig() reports the active mode + roots', async () => {
    const { describeSkillsConfig } = await import('./loader.js')
    const prev = process.env.IMHUB_SKILLS_MODE
    process.env.IMHUB_SKILLS_MODE = 'agim-only'
    try {
      const cfg = describeSkillsConfig()
      expect(cfg.mode).toBe('agim-only')
      expect(cfg.writeRoot).toBe(wsRoot)
      expect(cfg.readRoots).toEqual([wsRoot])
      expect(cfg.builtinRoot).toBe(builtinRoot)
    } finally {
      process.env.IMHUB_SKILLS_MODE = prev
    }
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

// v1.2.65 — YAML folded / literal block scalar handling in description.
describe('frontmatter description with YAML block scalar', () => {
  it('folds `description: >-` continuation lines into a single line', () => {
    writeSkill(wsRoot, 'folded-desc', `---
name: folded-desc
description: >-
  Use this skill when the user asks about
  multi-line descriptions that fold into one.
---
body
`)
    invalidateSkillsCache()
    const s = getSkillByName('folded-desc')
    expect(s).not.toBeNull()
    expect(s!.description).toBe('Use this skill when the user asks about multi-line descriptions that fold into one.')
  })

  it('preserves newlines for `description: |-`', () => {
    writeSkill(wsRoot, 'literal-desc', `---
name: literal-desc
description: |-
  line one
  line two
---
body
`)
    invalidateSkillsCache()
    const s = getSkillByName('literal-desc')
    expect(s).not.toBeNull()
    expect(s!.description).toBe('line one\nline two')
  })

  it('stops folding at the next top-level key', () => {
    writeSkill(wsRoot, 'fold-stops', `---
name: fold-stops
description: >-
  one
  two
always: false
metadata: '{"agim":{}}'
---
body
`)
    invalidateSkillsCache()
    const s = getSkillByName('fold-stops')
    expect(s).not.toBeNull()
    expect(s!.description).toBe('one two')
    expect(s!.always).toBe(false)
  })

  it('IMHUB_INCLUDE_ECC_SKILLS=off filters skills with origin: ECC (v1.2.148)', () => {
    writeSkill(wsRoot, 'ecc-pack-sample', `---
name: ecc-pack-sample
description: A bundled ECC skill that should be dropped when the env knob is off.
origin: ECC
---
body
`)
    writeSkill(wsRoot, 'plain-skill', `---
name: plain-skill
description: A non-ECC skill that should always load.
---
body
`)
    process.env.IMHUB_INCLUDE_ECC_SKILLS = 'off'
    invalidateSkillsCache()
    expect(getSkillByName('ecc-pack-sample')).toBeNull()
    expect(getSkillByName('plain-skill')).not.toBeNull()
    delete process.env.IMHUB_INCLUDE_ECC_SKILLS
    invalidateSkillsCache()
    expect(getSkillByName('ecc-pack-sample')).not.toBeNull()
    expect(getSkillByName('plain-skill')).not.toBeNull()
    process.env.IMHUB_INCLUDE_ECC_SKILLS = 'yes'
    invalidateSkillsCache()
    expect(getSkillByName('ecc-pack-sample')).not.toBeNull()
    delete process.env.IMHUB_INCLUDE_ECC_SKILLS
  })

  it('rankSkillBucket and bucket-aware sort prioritize agim-* / non-ECC builtin / ECC top picks (v1.2.149)', async () => {
    const { rankSkillBucket } = await import('./loader.js')

    // Six fixtures spanning all four buckets:
    writeSkill(wsRoot, 'fin-data-style-pinning', `---
name: fin-data-style-pinning
description: User business skill; should land in bucket 3 (low priority).
---
body
`)
    writeSkill(builtinRoot, 'agim-self-stub', `---
name: agim-self-stub
description: Framework skill; should land in bucket 0 (highest priority).
---
body
`)
    writeSkill(builtinRoot, 'github-stub', `---
name: github-stub
description: Non-ECC builtin; should land in bucket 1.
---
body
`)
    writeSkill(builtinRoot, 'agent-eval', `---
name: agent-eval
description: ECC top-pick; should land in bucket 2.
origin: ECC
---
body
`)
    writeSkill(builtinRoot, 'kotlin-coroutines-flows', `---
name: kotlin-coroutines-flows
description: ECC non-pick; should land in bucket 3 (alphabetically late among non-picks).
origin: ECC
---
body
`)

    invalidateSkillsCache()
    const all = listSkills()
    const byName = (n: string) => all.find((s) => s.name === n)!

    // Direct rankSkillBucket assertions
    expect(rankSkillBucket(byName('agim-self-stub'))).toBe(0)
    expect(rankSkillBucket(byName('github-stub'))).toBe(1)
    expect(rankSkillBucket(byName('agent-eval'))).toBe(2)
    expect(rankSkillBucket(byName('kotlin-coroutines-flows'))).toBe(3)
    expect(rankSkillBucket(byName('fin-data-style-pinning'))).toBe(3)

    // Summary block order: agim-* and github-stub MUST appear before
    // agent-eval, which MUST appear before kotlin-* / fin-data-*.
    const summary = buildSkillsSummary()
    const idxAgim = summary.indexOf('- agim-self-stub:')
    const idxGithub = summary.indexOf('- github-stub:')
    const idxEccPick = summary.indexOf('- agent-eval:')
    const idxEccRemainder = summary.indexOf('- kotlin-coroutines-flows:')
    const idxWorkspace = summary.indexOf('- fin-data-style-pinning:')
    expect(idxAgim).toBeGreaterThan(0)
    expect(idxGithub).toBeGreaterThan(idxAgim)
    expect(idxEccPick).toBeGreaterThan(idxGithub)
    // The remainder may fall outside the visible cap on a real install,
    // but with only 6 fixtures they all fit; they must rank below the
    // pick in the listing.
    if (idxEccRemainder > -1) expect(idxEccRemainder).toBeGreaterThan(idxEccPick)
    if (idxWorkspace > -1) expect(idxWorkspace).toBeGreaterThan(idxEccPick)
  })

  it('buildSkillsSummary produces a real description (NOT ">-") for fin-data-style frontmatter', () => {
    // Reproduces the bug observed in production: fin-data-* skills
    // showed up in the system prompt as `- fin-data-bond-otc: >-`
    // because their SKILL.md used a folded scalar that the old
    // line-by-line parser stored as literal ">-". With v1.2.65's
    // fold support, the description now contains the continuation
    // text instead.
    writeSkill(wsRoot, 'fin-data-style', `---
name: fin-data-style
description: >-
  Query the local A-share database for daily quotes and indicators.
  Use this when the user asks about Chinese stock prices, PE, PB,
  market cap, or sector rotation.
---
body content
`)
    invalidateSkillsCache()
    const summary = buildSkillsSummary()
    expect(summary).toContain('fin-data-style')
    expect(summary).toContain('Chinese stock prices')
    // And critically: NOT a raw `>-` literal in the description slot.
    expect(summary).not.toMatch(/- fin-data-style:\s*>-/)
  })
})
