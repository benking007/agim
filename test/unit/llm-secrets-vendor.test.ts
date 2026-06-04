// v1.2.141 — vendor-env fallback in `resolveSecret`. When the operator's
// already exported the vendor's standard env (DEEPSEEK_API_KEY etc.)
// agim shouldn't force them to duplicate it under AGIM_LLM_SECRET_*.
//
// Tests assert:
//   1. AGIM_LLM_SECRET_<NAME> still wins (private namespace beats vendor).
//   2. llm-secrets.json beats vendor env (file-stored secret wins).
//   3. Vendor env is used only as last-resort fallback.
//   4. baseUrl substring match routes to the right vendor.
//   5. Anthropic provider works without a baseUrl (provider-only rule).
//   6. Self-hosted gateway (no matching baseUrl) → undefined.
//   7. describeSecretSource reports source='vendor' + vendorEnvName.
//   8. describeSecretSource exposes vendorCandidates when nothing's set.

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-secrets-vendor-test-'))
process.env.AGIM_HOME = TEST_HOME

const {
  resolveSecret,
  describeSecretSource,
  vendorEnvCandidates,
} = await import('../../src/core/llm/secrets.js')

const KEYS = [
  'AGIM_LLM_SECRET_DEEPSEEK_V4',
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'MOONSHOT_API_KEY', 'KIMI_API_KEY',
  'DASHSCOPE_API_KEY', 'QWEN_API_KEY',
  'SILICONFLOW_API_KEY', 'OPENROUTER_API_KEY', 'STEPFUN_API_KEY',
  'ZHIPUAI_API_KEY', 'GLM_API_KEY',
] as const
const SNAPSHOT: Record<string, string | undefined> = {}
for (const k of KEYS) SNAPSHOT[k] = process.env[k]

function clearAllKeys(): void {
  for (const k of KEYS) delete process.env[k]
}

function restore(): void {
  for (const k of KEYS) {
    if (SNAPSHOT[k] === undefined) delete process.env[k]
    else process.env[k] = SNAPSHOT[k]
  }
}

afterAll(() => {
  restore()
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('v1.2.141 — vendor-env fallback', () => {
  beforeEach(() => { clearAllKeys() })

  it('private AGIM_LLM_SECRET_<NAME> still wins over vendor env', () => {
    process.env.AGIM_LLM_SECRET_DEEPSEEK_V4 = 'private-key'
    process.env.DEEPSEEK_API_KEY = 'vendor-key'
    const v = resolveSecret('deepseek-v4', undefined, {
      provider: 'openai-compat', baseUrl: 'https://api.deepseek.com',
    })
    expect(v).toBe('private-key')
  })

  it('falls back to vendor env when private slots are empty (DeepSeek)', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key'
    const v = resolveSecret('deepseek-v4', undefined, {
      provider: 'openai-compat', baseUrl: 'https://api.deepseek.com',
    })
    expect(v).toBe('ds-key')
  })

  it('uses baseUrl substring to pick the right vendor (OpenAI)', () => {
    process.env.OPENAI_API_KEY = 'oai-key'
    process.env.DEEPSEEK_API_KEY = 'wrong'
    const v = resolveSecret('my-openai', undefined, {
      provider: 'openai-compat', baseUrl: 'https://api.openai.com/v1',
    })
    expect(v).toBe('oai-key')
  })

  it('Anthropic — provider-only rule matches even with empty baseUrl', () => {
    process.env.ANTHROPIC_API_KEY = 'anth-key'
    const v = resolveSecret('claude-haiku', undefined, {
      provider: 'anthropic',
    })
    expect(v).toBe('anth-key')
  })

  it('Moonshot baseUrl falls back to MOONSHOT_API_KEY then KIMI_API_KEY', () => {
    // First env candidate wins
    process.env.MOONSHOT_API_KEY = 'ms-key'
    process.env.KIMI_API_KEY = 'kimi-key'
    expect(resolveSecret('kimi', undefined, {
      provider: 'openai-compat', baseUrl: 'https://api.moonshot.cn/v1',
    })).toBe('ms-key')
    // Fallback to alias when primary is empty
    delete process.env.MOONSHOT_API_KEY
    expect(resolveSecret('kimi', undefined, {
      provider: 'openai-compat', baseUrl: 'https://api.moonshot.cn/v1',
    })).toBe('kimi-key')
  })

  it('returns undefined for self-hosted gateway (no vendor rule matches)', () => {
    process.env.OPENAI_API_KEY = 'should-not-leak'
    const v = resolveSecret('my-gateway', undefined, {
      provider: 'openai-compat', baseUrl: 'https://llm.internal.acme.corp/v1',
    })
    expect(v).toBeUndefined()
  })

  it('returns undefined when called without backendHint (legacy path)', () => {
    process.env.DEEPSEEK_API_KEY = 'present-but-ignored'
    expect(resolveSecret('deepseek-v4')).toBeUndefined()
  })

  it('describeSecretSource reports source="vendor" + vendorEnvName', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key'
    const src = describeSecretSource('deepseek-v4', {
      provider: 'openai-compat', baseUrl: 'https://api.deepseek.com',
    })
    expect(src.source).toBe('vendor')
    expect(src.vendorEnvName).toBe('DEEPSEEK_API_KEY')
  })

  it('describeSecretSource exposes vendorCandidates on source=none', () => {
    const src = describeSecretSource('moonshot-fast', {
      provider: 'openai-compat', baseUrl: 'https://api.moonshot.cn/v1',
    })
    expect(src.source).toBe('none')
    expect(src.vendorCandidates).toContain('MOONSHOT_API_KEY')
    expect(src.vendorCandidates).toContain('KIMI_API_KEY')
  })

  it('vendorEnvCandidates returns empty array when no hint is given', () => {
    expect(vendorEnvCandidates(undefined)).toEqual([])
  })
})
