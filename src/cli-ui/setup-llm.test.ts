// Unit tests for the setup-llm wizard helpers (Stage 4).
// We exercise the internal pure helpers + the runSetupLlm top-level
// dispatcher's "help / unknown subcommand" paths. The interactive
// branches (add / role / secret / remove) need a TTY-like readline,
// so they're left to manual / e2e coverage.

import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Set AGIM_HOME BEFORE first import so agim-paths' module-level const
// caches our throwaway dir. When this file shares a bun run with
// llm-api.test.ts (also temp-dir-based), whichever file's import runs
// first wins; we re-read the resolved AGIM_HOME and use IT as our
// working dir so both files agree on where state lives.
const TMP_OWN = mkdtempSync(join(tmpdir(), 'agim-setup-llm-'))
process.env.AGIM_HOME = TMP_OWN

const { _internal, _wired, runSetupLlm } = await import('./setup-llm.js')
const { AGIM_HOME } = await import('../core/agim-paths.js')
const TMP = AGIM_HOME

beforeEach(() => {
  // wipe + recreate the dir between cases so list/remove state
  // doesn't leak.
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

describe('setup-llm — internal helpers', () => {
  it('suggestBackendName trims punctuation from the preset label', () => {
    const sample = _internal.PROVIDER_PRESETS[0]
    const name = _internal.suggestBackendName(sample.provider, sample)
    expect(name).toMatch(/^[a-z0-9-]+$/)
    expect(name.length).toBeGreaterThan(0)
  })

  it('envSuffix uppercases + replaces non-alnum with underscore', () => {
    expect(_internal.envSuffix('deepseek-cheap')).toBe('DEEPSEEK_CHEAP')
    expect(_internal.envSuffix('foo.bar')).toBe('FOO_BAR')
    expect(_internal.envSuffix('UPPER-Case')).toBe('UPPER_CASE')
  })

  it('PROVIDER_PRESETS includes openai-compat AND anthropic entries', () => {
    const providers = new Set(_internal.PROVIDER_PRESETS.map((p) => p.provider))
    expect(providers.has('openai-compat')).toBe(true)
    expect(providers.has('anthropic')).toBe(true)
  })

  it('KNOWN_ROLES covers cheap / evaluator / native-chat', () => {
    expect([..._internal.KNOWN_ROLES].sort()).toEqual(['cheap', 'evaluator', 'native-chat'])
  })

  it('exports the listConfiguredBackends helper for downstream UIs', () => {
    expect(typeof _wired.listConfiguredBackends).toBe('function')
  })
})

describe('runSetupLlm — non-interactive paths', () => {
  it('returns 0 for empty argv (renders help)', async () => {
    expect(await runSetupLlm([])).toBe(0)
  })

  it('returns 0 for "help" / "-h"', async () => {
    expect(await runSetupLlm(['help'])).toBe(0)
    expect(await runSetupLlm(['-h'])).toBe(0)
    expect(await runSetupLlm(['--help'])).toBe(0)
  })

  it('returns 1 for unknown subcommand', async () => {
    expect(await runSetupLlm(['mystery'])).toBe(1)
  })

  it('list on a fresh install prints "no backends" and returns 0', async () => {
    expect(await runSetupLlm(['list'])).toBe(0)
  })

  it('remove on a fresh install prints "no backends" and returns 0', async () => {
    expect(await runSetupLlm(['remove', 'nothing'])).toBe(0)
  })

  it('does not create config.json on read-only paths (list/help)', async () => {
    await runSetupLlm(['help'])
    await runSetupLlm(['list'])
    expect(existsSync(join(TMP, 'config.json'))).toBe(false)
  })

  it('secret on a no-backend install aborts with non-zero', async () => {
    expect(await runSetupLlm(['secret', 'nothing'])).toBe(1)
  })

  it('role on a no-backend install aborts with non-zero', async () => {
    expect(await runSetupLlm(['role'])).toBe(1)
  })
})

describe('runSetupLlm — round-trip via the wizard touches the config in cancel mode', () => {
  it('does not corrupt an existing config when remove fails', async () => {
    // Seed a tiny config so we can verify the wizard doesn't truncate it.
    const seed = { messengers: ['telegram'], agents: ['claude-code'], defaultAgent: 'claude-code' }
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(TMP, { recursive: true })
    writeFileSync(join(TMP, 'config.json'), JSON.stringify(seed, null, 2))

    await runSetupLlm(['remove', 'does-not-exist'])
    const after = JSON.parse(readFileSync(join(TMP, 'config.json'), 'utf-8'))
    expect(after).toEqual(seed)
  })
})
