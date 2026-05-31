// v1.2.118 — web-search provider chain.
//
// Pins:
//   - default chain is 'tavily,duckduckgo,metaso'
//   - providers whose `available()` returns false are dropped silently
//   - unknown names are dropped with a warn (don't disable the chain)
//   - empty chain ⇒ structured error from runWebSearch (no hard crash)
//   - parseTavilyResults handles missing fields tolerantly

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  resolveSearchProviderChain,
  parseTavilyResults,
} from '../../src/core/llm/web-dispatcher.js'

describe('web-search provider chain (v1.2.118)', () => {
  const savedOrder = process.env.IMHUB_WEB_SEARCH_PROVIDERS
  const savedTavily = process.env.TAVILY_API_KEY
  const savedMetaso = process.env.METASO_API_KEY
  beforeEach(() => {
    delete process.env.IMHUB_WEB_SEARCH_PROVIDERS
    delete process.env.TAVILY_API_KEY
    delete process.env.METASO_API_KEY
  })
  afterEach(() => {
    if (savedOrder === undefined) delete process.env.IMHUB_WEB_SEARCH_PROVIDERS
    else process.env.IMHUB_WEB_SEARCH_PROVIDERS = savedOrder
    if (savedTavily === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = savedTavily
    if (savedMetaso === undefined) delete process.env.METASO_API_KEY
    else process.env.METASO_API_KEY = savedMetaso
  })

  it('default order is tavily → duckduckgo → metaso (skipping unavailable)', () => {
    // No keys set ⇒ only duckduckgo passes available().
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['duckduckgo'])
  })

  it('enables tavily when TAVILY_API_KEY is set', () => {
    process.env.TAVILY_API_KEY = 'tvly-fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['tavily', 'duckduckgo'])
  })

  it('enables metaso when METASO_API_KEY is set', () => {
    process.env.METASO_API_KEY = 'meta-fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['duckduckgo', 'metaso'])
  })

  it('custom IMHUB_WEB_SEARCH_PROVIDERS reorders the chain', () => {
    process.env.IMHUB_WEB_SEARCH_PROVIDERS = 'metaso,duckduckgo'
    process.env.METASO_API_KEY = 'meta-fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['metaso', 'duckduckgo'])
  })

  it('drops unknown provider names without breaking the chain', () => {
    process.env.IMHUB_WEB_SEARCH_PROVIDERS = 'kagi,duckduckgo,exa'
    const chain = resolveSearchProviderChain()
    // kagi + exa unknown → dropped; duckduckgo survives.
    expect(chain.map((p) => p.name)).toEqual(['duckduckgo'])
  })

  it('empty env ⇒ default order applies', () => {
    process.env.IMHUB_WEB_SEARCH_PROVIDERS = ''
    process.env.TAVILY_API_KEY = 'tvly-fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['tavily', 'duckduckgo'])
  })

  it('chain can be deliberately empty (no providers, all unknown)', () => {
    process.env.IMHUB_WEB_SEARCH_PROVIDERS = 'kagi,brave'
    const chain = resolveSearchProviderChain()
    expect(chain).toEqual([])
  })
})

describe('parseTavilyResults (v1.2.118)', () => {
  it('extracts title/url/snippet from Tavily {results: [...]} shape', () => {
    const hits = parseTavilyResults({
      results: [
        { title: 'First',  url: 'https://a.example', content: 'snippet one', score: 0.9 },
        { title: 'Second', url: 'https://b.example', content: 'snippet two', score: 0.8 },
      ],
    }, 10)
    expect(hits).toEqual([
      { title: 'First',  url: 'https://a.example', snippet: 'snippet one' },
      { title: 'Second', url: 'https://b.example', snippet: 'snippet two' },
    ])
  })

  it('falls back to `snippet` field when `content` is missing', () => {
    const hits = parseTavilyResults({
      results: [{ title: 'X', url: 'https://x', snippet: 'fallback snippet' }],
    }, 10)
    expect(hits[0]?.snippet).toBe('fallback snippet')
  })

  it('skips items missing title or url', () => {
    const hits = parseTavilyResults({
      results: [
        { title: 'OK', url: 'https://ok' },
        { title: '', url: 'https://blank' },
        { title: 'No url' },
        { url: 'https://no-title.example' },
      ],
    }, 10)
    expect(hits).toEqual([{ title: 'OK', url: 'https://ok', snippet: '' }])
  })

  it('respects the max param', () => {
    const hits = parseTavilyResults({
      results: [
        { title: 'a', url: 'https://1' },
        { title: 'b', url: 'https://2' },
        { title: 'c', url: 'https://3' },
      ],
    }, 2)
    expect(hits.length).toBe(2)
  })

  it('returns [] for malformed input', () => {
    expect(parseTavilyResults(null, 10)).toEqual([])
    expect(parseTavilyResults({}, 10)).toEqual([])
    expect(parseTavilyResults({ results: 'not-array' }, 10)).toEqual([])
  })
})
