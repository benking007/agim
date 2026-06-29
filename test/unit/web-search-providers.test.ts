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
  parseBraveResults,
  parseSerperResults,
  parseExaResults,
  parseMetasoResults,
} from '../../src/core/llm/web-dispatcher.js'

describe('web-search provider chain (v1.2.118 + v1.2.121)', () => {
  const KEYS = [
    'AGIM_WEB_SEARCH_PROVIDERS',
    'TAVILY_API_KEY', 'BRAVE_API_KEY', 'SERPER_API_KEY', 'EXA_API_KEY', 'METASO_API_KEY',
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

  it('default order (no keys) leaves only duckduckgo passing available()', () => {
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['duckduckgo'])
  })

  it('v1.2.121 default order is tavily,brave,serper,exa,duckduckgo,metaso', () => {
    process.env.TAVILY_API_KEY = 'fake'
    process.env.BRAVE_API_KEY = 'fake'
    process.env.SERPER_API_KEY = 'fake'
    process.env.EXA_API_KEY = 'fake'
    process.env.METASO_API_KEY = 'fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual([
      'tavily', 'brave', 'serper', 'exa', 'duckduckgo', 'metaso',
    ])
  })

  it('enables tavily when TAVILY_API_KEY is set', () => {
    process.env.TAVILY_API_KEY = 'tvly-fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['tavily', 'duckduckgo'])
  })

  it('enables brave / serper / exa when their keys are set', () => {
    process.env.BRAVE_API_KEY = 'fake'
    process.env.SERPER_API_KEY = 'fake'
    process.env.EXA_API_KEY = 'fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['brave', 'serper', 'exa', 'duckduckgo'])
  })

  it('enables metaso when METASO_API_KEY is set', () => {
    process.env.METASO_API_KEY = 'meta-fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['duckduckgo', 'metaso'])
  })

  it('custom AGIM_WEB_SEARCH_PROVIDERS reorders the chain', () => {
    process.env.AGIM_WEB_SEARCH_PROVIDERS = 'metaso,duckduckgo'
    process.env.METASO_API_KEY = 'meta-fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['metaso', 'duckduckgo'])
  })

  it('drops unknown provider names without breaking the chain', () => {
    process.env.AGIM_WEB_SEARCH_PROVIDERS = 'kagi,duckduckgo,exa'
    const chain = resolveSearchProviderChain()
    // kagi + exa unknown → dropped; duckduckgo survives.
    expect(chain.map((p) => p.name)).toEqual(['duckduckgo'])
  })

  it('empty env ⇒ default order applies', () => {
    process.env.AGIM_WEB_SEARCH_PROVIDERS = ''
    process.env.TAVILY_API_KEY = 'tvly-fake'
    const chain = resolveSearchProviderChain()
    expect(chain.map((p) => p.name)).toEqual(['tavily', 'duckduckgo'])
  })

  it('chain can be deliberately empty (no providers, all unknown)', () => {
    process.env.AGIM_WEB_SEARCH_PROVIDERS = 'kagi,brave'
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

describe('parseBraveResults (v1.2.121)', () => {
  it('extracts hits from Brave {web: {results: [...]}}', () => {
    const hits = parseBraveResults({
      web: {
        results: [
          { title: 'A', url: 'https://a', description: 'snip a' },
          { title: 'B', url: 'https://b', description: 'snip b' },
        ],
      },
    }, 10)
    expect(hits).toEqual([
      { title: 'A', url: 'https://a', snippet: 'snip a' },
      { title: 'B', url: 'https://b', snippet: 'snip b' },
    ])
  })

  it('returns [] when web.results is missing or malformed', () => {
    expect(parseBraveResults({}, 10)).toEqual([])
    expect(parseBraveResults({ web: { results: 'bad' } }, 10)).toEqual([])
    expect(parseBraveResults(null, 10)).toEqual([])
  })

  it('respects max', () => {
    const hits = parseBraveResults({
      web: { results: [
        { title: 'a', url: 'https://1' },
        { title: 'b', url: 'https://2' },
        { title: 'c', url: 'https://3' },
      ] },
    }, 2)
    expect(hits.length).toBe(2)
  })
})

describe('parseSerperResults (v1.2.121)', () => {
  it('extracts hits from Serper {organic: [...]} using `link` field', () => {
    const hits = parseSerperResults({
      organic: [
        { title: 'A', link: 'https://a', snippet: 'snip a' },
        { title: 'B', link: 'https://b', snippet: 'snip b' },
      ],
    }, 10)
    expect(hits).toEqual([
      { title: 'A', url: 'https://a', snippet: 'snip a' },
      { title: 'B', url: 'https://b', snippet: 'snip b' },
    ])
  })

  it('skips items missing title or link', () => {
    const hits = parseSerperResults({
      organic: [
        { title: 'good', link: 'https://x' },
        { title: '', link: 'https://blank' },
        { link: 'https://no-title' },
      ],
    }, 10)
    expect(hits).toEqual([{ title: 'good', url: 'https://x', snippet: '' }])
  })

  it('returns [] for malformed', () => {
    expect(parseSerperResults({}, 10)).toEqual([])
    expect(parseSerperResults(null, 10)).toEqual([])
  })
})

describe('parseExaResults (v1.2.121)', () => {
  it('extracts hits from Exa {results: [{title, url, text}]}', () => {
    const hits = parseExaResults({
      results: [
        { title: 'A', url: 'https://a', text: 'semantic body a' },
        { title: 'B', url: 'https://b', text: 'semantic body b' },
      ],
    }, 10)
    expect(hits).toEqual([
      { title: 'A', url: 'https://a', snippet: 'semantic body a' },
      { title: 'B', url: 'https://b', snippet: 'semantic body b' },
    ])
  })

  it('falls back to summary when text is missing', () => {
    const hits = parseExaResults({
      results: [{ title: 'C', url: 'https://c', summary: 'short' }],
    }, 10)
    expect(hits[0]?.snippet).toBe('short')
  })

  it('returns [] for malformed', () => {
    expect(parseExaResults({}, 10)).toEqual([])
    expect(parseExaResults(null, 10)).toEqual([])
  })
})

// v1.2.128 — regression test against the actual metaso payload shape
// observed on 2026-06-01. Before this fix parseMetasoResults returned
// [] on every real-world call because it only looked for `data.list` /
// `results` / `items`, never `webpages`. The admin UI's "测试" button
// surfaced this as "ok / 0 hits".
describe('parseMetasoResults (v1.2.128 hotfix)', () => {
  it('reads webpages[] — the actual 2026 metaso API shape', () => {
    // Verbatim subset of metaso.cn /api/v1/search response.
    const payload = {
      credits: 3,
      searchParameters: { q: 'agim ping', size: 3 },
      webpages: [
        { title: 'Agim Q', link: 'https://x/1', snippet: 'snip 1',
          score: 'medium', position: 1, date: '2023-12-28' },
        { title: 'Agim H', link: 'https://x/2', snippet: 'snip 2',
          score: 'medium', position: 2 },
        { title: 'IMDb',  link: 'https://x/3', snippet: 'snip 3',
          score: 'medium', position: 3 },
      ],
      total: 55,
    }
    const hits = parseMetasoResults(payload, 10)
    expect(hits).toHaveLength(3)
    expect(hits[0]).toEqual({
      title: 'Agim Q', url: 'https://x/1', snippet: 'snip 1',
    })
    expect(hits[2].url).toBe('https://x/3')
  })

  it('still honours the legacy `data.list[]` / `results[]` shapes', () => {
    expect(parseMetasoResults({
      data: { list: [{ title: 'L', link: 'https://l', snippet: 's' }] },
    }, 10)).toEqual([{ title: 'L', url: 'https://l', snippet: 's' }])
    expect(parseMetasoResults({
      results: [{ name: 'R', url: 'https://r', summary: 'sum' }],
    }, 10)).toEqual([{ title: 'R', url: 'https://r', snippet: 'sum' }])
  })

  it('caps to max and tolerates missing snippet', () => {
    const hits = parseMetasoResults({
      webpages: [
        { title: 'A', link: 'https://a' },
        { title: 'B', link: 'https://b', snippet: 'b' },
        { title: 'C', link: 'https://c' },
      ],
    }, 2)
    expect(hits).toHaveLength(2)
    expect(hits[0].snippet).toBe('')
  })

  it('returns [] for malformed', () => {
    expect(parseMetasoResults({}, 10)).toEqual([])
    expect(parseMetasoResults(null, 10)).toEqual([])
    // webpages must be an array — a string is not.
    expect(parseMetasoResults({ webpages: 'oops' }, 10)).toEqual([])
  })
})
