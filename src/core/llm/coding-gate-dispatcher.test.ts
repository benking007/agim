import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCodingGateDispatcher,
  getCodingGateTools,
  isCodingGateToolName,
  CODING_READ_SAFE,
} from './coding-gate-dispatcher.js'

const NEVER = new AbortController().signal
const REPO = '/workspace'

describe('coding-gate-dispatcher', () => {
  it('advertises diagnostics + test + quality_gate', () => {
    const names = getCodingGateTools().map((t) => t.name).sort()
    expect(names).toEqual([
      'agim_diagnostics',
      'agim_quality_gate',
      'agim_test_run',
    ])
    expect(isCodingGateToolName('agim_diagnostics')).toBe(true)
    expect(CODING_READ_SAFE.has('agim_diagnostics')).toBe(true)
    expect(CODING_READ_SAFE.has('agim_test_run')).toBe(false)
  })

  it('agim_diagnostics returns biome JSON findings for a sample file', async () => {
    if (!existsSync(join(REPO, 'node_modules', '.bin', 'biome'))) {
      return // skip when biome binary absent (omit=optional CI)
    }
    const dir = await mkdtemp(join(tmpdir(), 'agim-diag-'))
    try {
      // Biome needs config; reuse repo biome via cwd=/workspace and path to temp is awkward.
      // Instead check a real in-repo path that is known clean or report structured shape.
      const d = buildCodingGateDispatcher({ cwd: REPO })
      const r = await d(
        {
          id: '1',
          name: 'agim_diagnostics',
          arguments: { path: 'src/core/llm/run-cmd.ts', max_findings: 20 },
        },
        NEVER,
      )
      expect(r.source).toBe('coding')
      const parsed = JSON.parse(r.text) as {
        engine: string
        findings: unknown[]
        ok: boolean
      }
      expect(parsed.engine).toBe('biome')
      expect(Array.isArray(parsed.findings)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('agim_quality_gate runs lint-only against this repo (may pass or fail, must be structured)', async () => {
    if (!existsSync(join(REPO, 'package.json'))) return
    const d = buildCodingGateDispatcher({ cwd: REPO })
    const r = await d(
      {
        id: '1',
        name: 'agim_quality_gate',
        arguments: { checks: ['lint'], timeout_ms: 180_000 },
      },
      NEVER,
    )
    const parsed = JSON.parse(r.text) as {
      ok: boolean
      steps: Array<{ name: string; ok: boolean; summary: string }>
    }
    expect(parsed.steps.length).toBe(1)
    expect(parsed.steps[0]?.name).toBe('lint')
    expect(typeof parsed.steps[0]?.summary).toBe('string')
    expect(parsed.ok).toBe(parsed.steps[0]!.ok)
  }, 200_000)

  it('agim_test_run unit filter on its own test file', async () => {
    if (!existsSync(join(REPO, 'package.json'))) return
    const d = buildCodingGateDispatcher({ cwd: REPO })
    const r = await d(
      {
        id: '1',
        name: 'agim_test_run',
        arguments: {
          suite: 'unit',
          filter: 'src/core/llm/run-cmd.ts', // no tests → bun may exit 0 with 0 files or fail
          timeout_ms: 120_000,
        },
      },
      NEVER,
    )
    const parsed = JSON.parse(r.text) as {
      suite: string
      command: string
      ok: boolean
    }
    expect(parsed.suite).toBe('unit')
    expect(parsed.command).toContain('npm')
  }, 150_000)
})

describe('coding-gate-dispatcher — stub package scripts', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agim-gate-stub-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'stub',
      scripts: {
        lint: 'node -e "console.log(\\"lint-ok\\"); process.exit(0)"',
        typecheck: 'node -e "console.log(\\"tc-ok\\"); process.exit(0)"',
        test: 'node -e "console.log(\\"test-ok\\"); process.exit(0)"',
      },
    }, null, 2))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('quality_gate default lint+typecheck+test all green on stub', async () => {
    const d = buildCodingGateDispatcher({ cwd: dir })
    const r = await d(
      { id: '1', name: 'agim_quality_gate', arguments: {} },
      NEVER,
    )
    expect(r.isError).toBe(false)
    const parsed = JSON.parse(r.text) as { ok: boolean; steps: Array<{ name: string; ok: boolean }> }
    expect(parsed.ok).toBe(true)
    expect(parsed.steps.map((s) => s.name)).toEqual(['lint', 'typecheck', 'test'])
    expect(parsed.steps.every((s) => s.ok)).toBe(true)
  })
})
