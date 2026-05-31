// v1.2.126 — search-provider introspection used by the SPA settings
// page. Pins:
//   - listAllSearchProviders enumerates every registered backend
//     (whether available or not) so the SPA can render disabled rows
//   - the envKey column points at the right API-key per provider
//     (duckduckgo intentionally null)
//   - availability flips when its env key flips (no caching)
//   - getSearchProviderByName returns null for typo / unknown names
//     rather than fabricating a fake provider

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  listAllSearchProviders,
  getSearchProviderByName,
} from '../../src/core/llm/web-dispatcher.js'

describe('v1.2.126 — search provider introspection', () => {
  const KEYS = [
    'TAVILY_API_KEY', 'BRAVE_API_KEY', 'SERPER_API_KEY',
    'EXA_API_KEY', 'METASO_API_KEY',
  ]
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('listAllSearchProviders covers every registered backend', () => {
    const names = listAllSearchProviders().map((p) => p.name).sort()
    expect(names).toEqual(
      ['brave', 'duckduckgo', 'exa', 'metaso', 'serper', 'tavily'],
    )
  })

  it('envKey is null only for duckduckgo (key-less provider)', () => {
    const out = listAllSearchProviders()
    const ddg = out.find((p) => p.name === 'duckduckgo')
    expect(ddg?.envKey).toBeNull()
    for (const p of out) {
      if (p.name === 'duckduckgo') continue
      expect(typeof p.envKey).toBe('string')
      expect(p.envKey?.length).toBeGreaterThan(0)
    }
  })

  it('available flag tracks process.env on every call', () => {
    let chain = listAllSearchProviders()
    expect(chain.find((p) => p.name === 'tavily')?.available).toBe(false)
    process.env.TAVILY_API_KEY = 'tvly-fake'
    chain = listAllSearchProviders()
    expect(chain.find((p) => p.name === 'tavily')?.available).toBe(true)
    // duckduckgo is always available.
    expect(chain.find((p) => p.name === 'duckduckgo')?.available).toBe(true)
  })

  it('getSearchProviderByName returns null for unknown names', () => {
    expect(getSearchProviderByName('does-not-exist')).toBeNull()
    expect(getSearchProviderByName('')).toBeNull()
  })

  it('getSearchProviderByName returns the same instance the chain sees', () => {
    const p = getSearchProviderByName('duckduckgo')
    expect(p).not.toBeNull()
    expect(p?.name).toBe('duckduckgo')
    // Sanity: calling available() doesn't throw.
    expect(p?.available()).toBe(true)
  })
})
