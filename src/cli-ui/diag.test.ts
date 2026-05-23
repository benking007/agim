// Unit tests for the P2 `agim diag *` self-checks.
//
// We exercise the pure helper (table()) and the empty-config branches
// of runDiagLlm / runDiagMcp. The actual LLM ping + MCP reconnect
// happy paths need real backends or full mocks; the modules already
// log every state transition + return non-zero on failures, so we
// rely on the existing llm-provider / mcp-client test coverage for
// those branches.

import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_OWN = mkdtempSync(join(tmpdir(), 'agim-diag-'))
process.env.AGIM_HOME = TMP_OWN

const { runDiagLlm, runDiagMcp, _internal } = await import('./diag.js')
const { AGIM_HOME } = await import('../core/agim-paths.js')
const TMP = AGIM_HOME

function setConfig(cfg: Record<string, unknown>): void {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'config.json'), JSON.stringify(cfg, null, 2))
}

beforeEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  mkdirSync(TMP, { recursive: true })
})

describe('diag helpers', () => {
  it('table() pads columns to the widest cell', () => {
    const out = _internal.table(['A', 'BB'], [['x', 'yyyy'], ['xxxxx', 'z']])
    const lines = out.split('\n')
    expect(lines[0]).toBe('A      BB  ')
    expect(lines[1]).toBe('-----  ----')
    expect(lines[2]).toBe('x      yyyy')
    expect(lines[3]).toBe('xxxxx  z   ')
  })

  it('readConfig returns empty when config.json missing', async () => {
    expect(await _internal.readConfig()).toEqual({})
  })
})

describe('runDiagLlm', () => {
  it('returns 0 + prints "no backends" hint when none configured', async () => {
    const code = await runDiagLlm()
    expect(code).toBe(0)
  })

  it('returns 0 for backend rows that have no key (skipped, no ERR)', async () => {
    setConfig({
      llmBackends: [
        { name: 'unconfigured', provider: 'openai-compat', model: 'm',
          baseUrl: 'https://api.example.com/v1' },
      ],
    })
    const code = await runDiagLlm()
    // Missing key -> row prints `(no key: ...)` and exits 0 (not an ERR)
    expect(code).toBe(0)
  })
})

describe('runDiagMcp', () => {
  it('returns 0 + prints "no servers" when none configured', async () => {
    const code = await runDiagMcp()
    expect(code).toBe(0)
  })
})
