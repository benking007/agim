// web-dispatcher — read-only web tools for the native agent.
//
// Two tools shipped:
//   - native_web_fetch(url, format?)   GET + optional Jina Reader text extract
//   - native_web_search(query, n?)     configurable provider chain
//
// Both have:
//   * 30s default per-call timeout (override via IMHUB_NATIVE_WEB_TIMEOUT_MS)
//   * SSRF block — RFC1918 / localhost / link-local are denied unless
//     IMHUB_NATIVE_WEB_ALLOW_PRIVATE=1
//   * Body / result size cap to keep the model context manageable
//
// v1.2.118 — web_search now drives an ORDERED PROVIDER CHAIN via
// `IMHUB_WEB_SEARCH_PROVIDERS` (default 'tavily,duckduckgo,metaso').
// Each entry implements the SearchProvider interface below; providers
// whose API key is missing are silently skipped, so adding TAVILY_API_KEY
// to the env is enough to flip Tavily on. The first provider returning
// ≥1 result wins.
//
// All tools are read-only and safe to default-allow in native's policy.

import net from 'node:net'
import { logger as rootLogger } from '../logger.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'

const log = rootLogger.child({ component: 'web-dispatcher' })

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_FETCH_MAX_BYTES = 200 * 1024  // 200 KB after extract
const DEFAULT_SEARCH_RESULTS = 8
const DDG_SEARCH_URL = 'https://duckduckgo.com/html/?q='
const METASO_API_BASE = 'https://metaso.cn/api/v1'  // adapt if path differs
const TAVILY_API_URL = 'https://api.tavily.com/search'
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search'
const SERPER_API_URL = 'https://google.serper.dev/search'
const EXA_API_URL = 'https://api.exa.ai/search'
const JINA_READER_BASE = 'https://r.jina.ai/'
// v1.2.121 — chain now spans 6 providers. Order: agent-tuned (Tavily/Exa)
// → fast-and-cheap (Brave/Serper) → free fallbacks (DDG/Metaso).
const DEFAULT_PROVIDER_ORDER = 'tavily,brave,serper,exa,duckduckgo,metaso'

const WEB_TOOL_NAMES = ['native_web_fetch', 'native_web_search'] as const
export function isWebToolName(name: string): boolean {
  return (WEB_TOOL_NAMES as readonly string[]).includes(name)
}

export function getWebTools(): ToolDef[] {
  return [
    {
      name: 'native_web_fetch',
      description:
        'Fetch the contents of a SPECIFIC, KNOWN URL the user already supplied (or that you pulled ' +
        'from search results). DO NOT use this to "find" / "look up" / "search" / "discover" — ' +
        'use native_web_search for that. ' +
        '\n\n' +
        '**Trigger phrases**: "读这个页面/链接 …" · "fetch …" · "open this URL …" · "看一下 https://…" · ' +
        'when you have a result from native_web_search and want the full body. ' +
        '\n\n' +
        'Default `format="reader"` runs the URL through r.jina.ai for HTML→text extraction; ' +
        '`format="raw"` returns the response body verbatim (use for JSON APIs). 200KB max, ' +
        '30s timeout. Private IP ranges blocked unless IMHUB_NATIVE_WEB_ALLOW_PRIVATE=1.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL to fetch.' },
          format: {
            type: 'string',
            enum: ['reader', 'raw'],
            description: 'reader (default): r.jina.ai text extract. raw: response body as-is.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'native_web_search',
      description:
        'Web search by KEYWORDS — use this when the user wants to FIND / LOOK UP / DISCOVER ' +
        'something and you do NOT already have a specific URL. Returns up to 8 results with ' +
        'title + url + snippet; if any result is interesting, follow up with native_web_fetch ' +
        'on the chosen URL. ' +
        '\n\n' +
        '**Trigger phrases (Chinese)**: "查找 …" · "搜一下 …" · "找最新 …" · "搜索 …" · ' +
        '"今天/最近的 X 是什么" · "X 的相关资料 / 教程 / 新闻". ' +
        '\n\n' +
        '**Trigger phrases (English)**: "search for …" · "find …" · "look up …" · ' +
        '"what\'s the latest on …" · "any news about …". ' +
        '\n\n' +
        'DO NOT use native_web_fetch when the user only gave keywords without a URL — ' +
        'always start with native_web_search, then optionally native_web_fetch on a result. ' +
        '\n\n' +
        'Backend chain configurable via IMHUB_WEB_SEARCH_PROVIDERS '
        + '(default "tavily,brave,serper,exa,duckduckgo,metaso"). Key env vars: '
        + 'TAVILY_API_KEY (agent-tuned, recommended), BRAVE_API_KEY (cheap, free 2K/mo), '
        + 'SERPER_API_KEY (Google SERP relay), EXA_API_KEY (semantic), '
        + 'METASO_API_KEY (中文 AI 搜索). DuckDuckGo needs none. Providers '
        + 'whose key is missing are skipped silently — set the env vars '
        + 'you want and the chain picks the first that returns ≥1 hit.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          n: { type: 'number', description: 'Max results (default 8, hard cap 20).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ]
}

export function buildWebDispatcher(): ToolDispatcher {
  return async (call, signal): Promise<DispatcherResult> => {
    if (!isWebToolName(call.name)) {
      return { text: `not handled: ${call.name}`, isError: true, source: 'unknown' }
    }
    const timeoutMs = resolveTimeoutMs()
    try {
      return await raceTimeout(runOne(call.name, call.arguments, signal), timeoutMs, call.name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'web.tool.error', tool: call.name, err: msg })
      return { text: `${call.name} failed: ${msg}`, isError: true, source: 'web' }
    }
  }
}

async function runOne(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DispatcherResult> {
  switch (name) {
    case 'native_web_fetch': return runWebFetch(args, signal)
    case 'native_web_search': return runWebSearch(args, signal)
    default:
      return { text: `unknown web tool: ${name}`, isError: true, source: 'web' }
  }
}

// ─── web_fetch ───────────────────────────────────────────────────────

async function runWebFetch(args: Record<string, unknown>, signal: AbortSignal): Promise<DispatcherResult> {
  const url = typeof args.url === 'string' ? args.url : ''
  if (!url) return { text: 'url required', isError: true, source: 'web' }
  const format = args.format === 'raw' ? 'raw' : 'reader'

  const safe = checkUrlSafety(url)
  if (!safe.ok) return { text: `web_fetch refused: ${safe.reason}`, isError: true, source: 'web' }

  const initialTarget = format === 'reader'
    ? `${JINA_READER_BASE}${url}`
    : url
  try {
    const res = await fetchWithSafeRedirects(initialTarget, signal, format)
    if (!res.ok) {
      return { text: res.error, isError: true, source: 'web' }
    }
    if (!res.response.ok) {
      return {
        text: JSON.stringify({ url: res.finalUrl, format, status: res.response.status, statusText: res.response.statusText, body: '' }, null, 2),
        isError: true,
        source: 'web',
      }
    }
    const body = await readCapped(res.response, DEFAULT_FETCH_MAX_BYTES)
    return {
      text: JSON.stringify({
        url: res.finalUrl,
        format,
        status: res.response.status,
        contentType: res.response.headers.get('content-type') ?? null,
        redirected_via: res.redirectChain.length > 0 ? res.redirectChain : undefined,
        bytes: body.text.length,
        truncated: body.truncated,
        body: body.text,
      }, null, 2),
      isError: false,
      source: 'web',
    }
  } catch (err) {
    return { text: `web_fetch failed: ${errMsg(err)}`, isError: true, source: 'web' }
  }
}

/**
 * v1.2.66 — SSRF-safe fetch with manual redirect handling.
 *
 * Default `fetch({redirect:'follow'})` follows 3xx Location transparently,
 * including to private IPs. That defeats the initial checkUrlSafety()
 * since the final fetch target wasn't validated. Mirror nanobot's
 * `validate_resolved_url`: redirect:'manual', loop ≤ 5 times, validate
 * each Location with checkUrlSafety before following.
 */
const MAX_REDIRECTS = 5
async function fetchWithSafeRedirects(
  initialUrl: string,
  signal: AbortSignal,
  format: 'reader' | 'raw',
): Promise<{ ok: true; response: Response; finalUrl: string; redirectChain: string[] } | { ok: false; error: string }> {
  let currentUrl = initialUrl
  const chain: string[] = []
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'agim-native/1.2.66 (+https://github.com/benking007/agim)',
        'Accept': format === 'reader' ? 'text/plain' : '*/*',
      },
    })
    // 3xx with Location → validate + follow.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) {
        return { ok: true, response: res, finalUrl: currentUrl, redirectChain: chain }
      }
      let nextUrl: string
      try {
        nextUrl = new URL(location, currentUrl).toString()
      } catch {
        return { ok: false, error: `web_fetch refused: invalid redirect Location "${location}"` }
      }
      const safe = checkUrlSafety(nextUrl)
      if (!safe.ok) {
        return { ok: false, error: `web_fetch refused: redirect target rejected — ${safe.reason}` }
      }
      // discard the redirect body (we don't need it)
      try { await res.body?.cancel() } catch { /* ignore */ }
      chain.push(currentUrl)
      currentUrl = nextUrl
      continue
    }
    return { ok: true, response: res, finalUrl: currentUrl, redirectChain: chain }
  }
  return { ok: false, error: `web_fetch refused: too many redirects (>${MAX_REDIRECTS})` }
}

// ─── web_search ──────────────────────────────────────────────────────

interface SearchHit {
  title: string
  url: string
  snippet: string
}

/**
 * v1.2.118 — pluggable search-provider interface. Each provider:
 *   - `name` is the env-config token (e.g. 'tavily')
 *   - `available()` short-circuits the chain when required keys are
 *     missing (so a fresh agim install without TAVILY_API_KEY skips
 *     Tavily without logging an error every search)
 *   - `search()` returns ≥0 SearchHit; an empty array means "no hits"
 *     and triggers fallback to the next provider, while a throw means
 *     "transient error" and is also followed by fallback (logged at
 *     warn). Either way, the chain continues until exhaustion.
 */
interface SearchProvider {
  name: string
  available(): boolean
  search(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]>
}

const PROVIDERS: Record<string, SearchProvider> = {
  tavily: {
    name: 'tavily',
    available: () => !!process.env.TAVILY_API_KEY,
    search: searchTavily,
  },
  // v1.2.121 — Brave Search: cheapest "real" web index (free 2K/mo);
  // privacy-positioned. Returns Google-quality results without scrape.
  brave: {
    name: 'brave',
    available: () => !!process.env.BRAVE_API_KEY,
    search: searchBrave,
  },
  // v1.2.121 — Serper: Google SERP via 3rd-party API. Fast + cheap;
  // most useful when you need "what would Google show" results.
  serper: {
    name: 'serper',
    available: () => !!process.env.SERPER_API_KEY,
    search: searchSerper,
  },
  // v1.2.121 — Exa: semantic (vector) search over a curated index.
  // Good for "find similar pages to <description>" agent queries
  // where keyword search would miss intent.
  exa: {
    name: 'exa',
    available: () => !!process.env.EXA_API_KEY,
    search: searchExa,
  },
  duckduckgo: {
    name: 'duckduckgo',
    available: () => true,                     // no key required
    search: searchDuckDuckGo,
  },
  metaso: {
    name: 'metaso',
    available: () => !!process.env.METASO_API_KEY,
    search: searchMetaso,
  },
}

/**
 * Read `IMHUB_WEB_SEARCH_PROVIDERS` (CSV) and return the active chain.
 * Unknown names are dropped with a one-shot warn (so a typo doesn't
 * silently disable the entire chain). Providers whose `available()`
 * returns false are also dropped — these are NOT logged because the
 * common case is "key not set, skip", not a misconfig.
 */
export function resolveSearchProviderChain(): SearchProvider[] {
  // Empty string is treated as "unset" — natural for env files where
  // clearing a value yields '' rather than removing the line. Use the
  // default order in that case.
  const envOrder = process.env.IMHUB_WEB_SEARCH_PROVIDERS
  const order = envOrder && envOrder.trim().length > 0 ? envOrder : DEFAULT_PROVIDER_ORDER
  const raw = order.split(',').map((s) => s.trim()).filter(Boolean)
  const chain: SearchProvider[] = []
  for (const name of raw) {
    const p = PROVIDERS[name]
    if (!p) {
      log.warn({ event: 'web.search.unknown_provider', name }, `unknown web-search provider "${name}" — skipped`)
      continue
    }
    if (!p.available()) continue
    chain.push(p)
  }
  return chain
}

/**
 * v1.2.126 — descriptor used by the SPA search settings page. Lists
 * every registered provider (whether in the env chain or not), with
 * its key-requirement flag and current availability so the operator
 * can see "Tavily ✓ configured / Brave ⚠ missing key" at a glance.
 */
export interface SearchProviderInfo {
  name: string
  envKey: string | null
  available: boolean
}

const PROVIDER_ENV_KEYS: Record<string, string | null> = {
  tavily:     'TAVILY_API_KEY',
  brave:      'BRAVE_API_KEY',
  serper:     'SERPER_API_KEY',
  exa:        'EXA_API_KEY',
  duckduckgo: null,
  metaso:     'METASO_API_KEY',
}

/** All known providers + each provider's env requirement & current
 *  availability. Order matches DEFAULT_PROVIDER_ORDER so the SPA can
 *  render a stable list when no env chain is configured. */
export function listAllSearchProviders(): SearchProviderInfo[] {
  return Object.keys(PROVIDERS).map((name) => ({
    name,
    envKey: PROVIDER_ENV_KEYS[name] ?? null,
    available: PROVIDERS[name].available(),
  }))
}

/** Look up a single provider by name. Returns null if unknown — the
 *  caller (e.g. /api/search/test) is expected to surface that as a
 *  400 with the supported names. */
export function getSearchProviderByName(name: string): SearchProvider | null {
  return PROVIDERS[name] ?? null
}

async function runWebSearch(args: Record<string, unknown>, signal: AbortSignal): Promise<DispatcherResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { text: 'query required', isError: true, source: 'web' }
  const n = clampNumber(args.n, DEFAULT_SEARCH_RESULTS, 1, 20)
  const chain = resolveSearchProviderChain()
  if (chain.length === 0) {
    return err(
      'web_search: no providers configured. Set IMHUB_WEB_SEARCH_PROVIDERS=tavily,duckduckgo,metaso ' +
      'and at least one of TAVILY_API_KEY / METASO_API_KEY (duckduckgo needs no key).',
    )
  }
  const tried: { name: string; reason: string }[] = []
  for (const provider of chain) {
    try {
      const hits = await provider.search(query, n, signal)
      if (hits.length > 0) {
        return ok({ query, backend: provider.name, count: hits.length, results: hits })
      }
      tried.push({ name: provider.name, reason: 'empty' })
      log.info({ event: 'web.search.empty', provider: provider.name, query },
        `provider "${provider.name}" returned 0 results — falling through to next`)
    } catch (e) {
      const msg = errMsg(e)
      tried.push({ name: provider.name, reason: msg })
      log.warn({ event: 'web.search.failed', provider: provider.name, err: msg })
    }
  }
  return err(
    `web_search: all ${chain.length} provider(s) returned no usable results — `
    + tried.map((t) => `${t.name}: ${t.reason}`).join('; '),
  )
}

/**
 * v1.2.118 — Tavily AI search. Industry-default agent search (small fast
 * index, snippet-rich, no scraping fragility). Returns up to N hits;
 * `score` is dropped to match the SearchHit shape — Tavily already
 * sorts by relevance. Throws on missing key (so the provider gate is
 * `available()`-driven; reaching this throw means env mutated between
 * available check and call, which is fine to surface).
 */
async function searchTavily(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.TAVILY_API_KEY
  if (!key) throw new Error('TAVILY_API_KEY not set')
  const body = {
    api_key: key,
    query,
    max_results: n,
    // 'basic' is faster + cheaper; 'advanced' adds answer synthesis we
    // don't need (the agent does its own synthesis from snippets).
    search_depth: 'basic' as const,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  }
  const res = await fetch(TAVILY_API_URL, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'agim-native' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // Tavily returns useful error bodies; surface them.
    const errBody = await res.text().catch(() => '')
    throw new Error(`tavily http ${res.status}: ${errBody.slice(0, 200)}`)
  }
  const data = await res.json() as unknown
  return parseTavilyResults(data, n)
}

/**
 * v1.2.121 — Brave Search (https://search.brave.com/help/api).
 * Headers carry the X-Subscription-Token API key; query is a `q` query
 * param. Response shape: `{web: {results: [{title, url, description}]}}`.
 * 60req/min on the free tier — we don't pace because the agent loop is
 * iter-bounded and a turn rarely calls search more than 5×.
 */
async function searchBrave(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.BRAVE_API_KEY
  if (!key) throw new Error('BRAVE_API_KEY not set')
  const url = `${BRAVE_API_URL}?q=${encodeURIComponent(query)}&count=${n}`
  const res = await fetch(url, {
    method: 'GET',
    signal,
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': key,
      'User-Agent': 'agim-native',
    },
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`brave http ${res.status}: ${errBody.slice(0, 200)}`)
  }
  const data = await res.json() as unknown
  return parseBraveResults(data, n)
}

export function parseBraveResults(data: unknown, max: number): SearchHit[] {
  if (!data || typeof data !== 'object') return []
  const d = data as { web?: { results?: unknown } }
  const results = d.web?.results
  if (!Array.isArray(results)) return []
  const out: SearchHit[] = []
  for (const item of results) {
    if (out.length >= max) break
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const title = typeof it.title === 'string' ? it.title : ''
    const url = typeof it.url === 'string' ? it.url : ''
    const snippet = typeof it.description === 'string' ? it.description : ''
    if (title && url) out.push({ title, url, snippet })
  }
  return out
}

/**
 * v1.2.121 — Serper (https://serper.dev). POST with API key in header,
 * returns Google's organic results shape `{organic: [{title, link,
 * snippet}]}`. Cheaper than direct Google API; same surface.
 */
async function searchSerper(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.SERPER_API_KEY
  if (!key) throw new Error('SERPER_API_KEY not set')
  const res = await fetch(SERPER_API_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': key,
      'User-Agent': 'agim-native',
    },
    body: JSON.stringify({ q: query, num: n }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`serper http ${res.status}: ${errBody.slice(0, 200)}`)
  }
  const data = await res.json() as unknown
  return parseSerperResults(data, n)
}

export function parseSerperResults(data: unknown, max: number): SearchHit[] {
  if (!data || typeof data !== 'object') return []
  const d = data as { organic?: unknown }
  if (!Array.isArray(d.organic)) return []
  const out: SearchHit[] = []
  for (const item of d.organic) {
    if (out.length >= max) break
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const title = typeof it.title === 'string' ? it.title : ''
    // Note: Serper uses `link`, not `url`.
    const url = typeof it.link === 'string' ? it.link : ''
    const snippet = typeof it.snippet === 'string' ? it.snippet : ''
    if (title && url) out.push({ title, url, snippet })
  }
  return out
}

/**
 * v1.2.121 — Exa (https://exa.ai). Semantic / neural search over a
 * curated index. Returns `{results: [{title, url, text, score}]}`. We
 * request `numResults` and skip `contents` (too verbose for SearchHit
 * shape; agent can web_fetch the URL it cares about).
 */
async function searchExa(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.EXA_API_KEY
  if (!key) throw new Error('EXA_API_KEY not set')
  const res = await fetch(EXA_API_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'User-Agent': 'agim-native',
    },
    body: JSON.stringify({ query, numResults: n, useAutoprompt: true }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`exa http ${res.status}: ${errBody.slice(0, 200)}`)
  }
  const data = await res.json() as unknown
  return parseExaResults(data, n)
}

export function parseExaResults(data: unknown, max: number): SearchHit[] {
  if (!data || typeof data !== 'object') return []
  const d = data as { results?: unknown }
  if (!Array.isArray(d.results)) return []
  const out: SearchHit[] = []
  for (const item of d.results) {
    if (out.length >= max) break
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const title = typeof it.title === 'string' ? it.title : ''
    const url = typeof it.url === 'string' ? it.url : ''
    // Exa returns `text` (snippet) when requested; usually present but
    // not guaranteed if useAutoprompt rephrased and content was sparse.
    const snippet = typeof it.text === 'string' ? it.text
      : typeof it.summary === 'string' ? it.summary : ''
    if (title && url) out.push({ title, url, snippet })
  }
  return out
}

/** Parse Tavily's `{results: [{title, url, content, score}]}` shape.
 *  Tolerant of missing fields: a hit needs title + url to be usable. */
export function parseTavilyResults(data: unknown, max: number): SearchHit[] {
  if (!data || typeof data !== 'object') return []
  const d = data as { results?: unknown }
  if (!Array.isArray(d.results)) return []
  const out: SearchHit[] = []
  for (const item of d.results) {
    if (out.length >= max) break
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const title = typeof it.title === 'string' ? it.title : ''
    const url = typeof it.url === 'string' ? it.url : ''
    const snippet = typeof it.content === 'string' ? it.content
      : typeof it.snippet === 'string' ? it.snippet : ''
    if (title && url) out.push({ title, url, snippet })
  }
  return out
}

async function searchDuckDuckGo(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const url = DDG_SEARCH_URL + encodeURIComponent(query)
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) agim-native/1.2.61',
    },
  })
  if (!res.ok) throw new Error(`ddg http ${res.status}`)
  const html = await res.text()
  return parseDdgHtml(html, n)
}

/** Tiny extractor for the DuckDuckGo HTML SERP. The DDG HTML page wraps
 *  each result in `<div class="result">` with `<a class="result__a" href="...">title</a>`
 *  + `<a class="result__snippet">snippet</a>`. We don't use a DOM parser
 *  (no dep), just regex — robust enough for SERPs (DDG is stable about
 *  these classes). */
export function parseDdgHtml(html: string, max: number): SearchHit[] {
  const out: SearchHit[] = []
  const blockRe = /<div\s+class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g
  for (let m = blockRe.exec(html); m !== null; m = blockRe.exec(html)) {
    if (out.length >= max) break
    const block = m[1]
    const aMatch = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!aMatch) continue
    const rawHref = aMatch[1]
    const url = unwrapDdgRedirect(rawHref)
    const title = stripTags(aMatch[2]).trim()
    const sMatch = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    const snippet = sMatch ? stripTags(sMatch[1]).trim() : ''
    if (url && title) out.push({ title, url, snippet })
  }
  return out
}

function unwrapDdgRedirect(href: string): string {
  // DDG wraps result URLs as `/l/?uddg=<encoded>&rut=…` or `//duckduckgo.com/l/?…`.
  // Pull out the uddg param if present.
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const inner = u.searchParams.get('uddg')
    if (inner) return decodeURIComponent(inner)
    return href.startsWith('http') ? href : `https:${href}`
  } catch {
    return href
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

async function searchMetaso(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.METASO_API_KEY
  if (!key) throw new Error('METASO_API_KEY not set (configure in agim env)')
  const url = `${METASO_API_BASE}/search`
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'User-Agent': 'agim-native/1.2.61',
    },
    body: JSON.stringify({ q: query, size: n }),
  })
  if (!res.ok) throw new Error(`metaso http ${res.status}`)
  const data = await res.json() as unknown
  return parseMetasoResults(data, n)
}

/** Best-effort metaso response normaliser. Field names from metaso vary
 *  with API version; we look at common shapes. Adjust here if metaso
 *  changes their schema. */
export function parseMetasoResults(data: unknown, max: number): SearchHit[] {
  if (!data || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  // common keys: `data.list[]`, `results[]`, `items[]`
  const candidates: unknown[] =
    (Array.isArray((d.data as Record<string, unknown>)?.list) && (d.data as Record<string, unknown>).list as unknown[]) ||
    (Array.isArray(d.results) && (d.results as unknown[])) ||
    (Array.isArray(d.items) && (d.items as unknown[])) ||
    []
  const out: SearchHit[] = []
  for (const item of candidates) {
    if (out.length >= max) break
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const title = typeof it.title === 'string' ? it.title
      : typeof it.name === 'string' ? it.name : ''
    const url = typeof it.url === 'string' ? it.url
      : typeof it.link === 'string' ? it.link : ''
    const snippet = typeof it.snippet === 'string' ? it.snippet
      : typeof it.summary === 'string' ? it.summary
      : typeof it.content === 'string' ? it.content : ''
    if (title && url) out.push({ title, url, snippet })
  }
  return out
}

// ─── SSRF safety ─────────────────────────────────────────────────────

interface SafetyResult { ok: boolean; reason?: string }

export function checkUrlSafety(raw: string): SafetyResult {
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: `invalid URL: ${raw}` } }
  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, reason: `protocol "${u.protocol}" not allowed (only http/https)` }
  }
  if (process.env.IMHUB_NATIVE_WEB_ALLOW_PRIVATE === '1') return { ok: true }

  // CIDR whitelist (v1.2.66). Tailscale 100.64.0.0/10 etc.
  const whitelist = parseSsrfWhitelist(process.env.IMHUB_NATIVE_WEB_SSRF_WHITELIST)

  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost is private (set IMHUB_NATIVE_WEB_ALLOW_PRIVATE=1 or whitelist via IMHUB_NATIVE_WEB_SSRF_WHITELIST)' }
  }

  // v1.2.70 — normalize hostname to an IP if possible BEFORE pattern
  // matching. Closes CR-3 (999.999.999.999 / decimal int / hex int
  // bypass) and CR-4 (IPv6 compressed-form ULA regex hole).
  //
  // Three parse paths:
  //   - bracketed IPv6 host ("[fe80::1]") → strip + net.isIPv6
  //   - dotted-quad / decimal-int / hex-int / octal-int → tryParseIPv4Variants
  //   - hostname → leave for v4/v6 check; non-IP names pass (treated
  //     as DNS targets; CR-2 DNS rebind is a separate fix slot)
  const v6Host = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (net.isIPv6(v6Host)) {
    return checkIpv6Safety(v6Host)
  }
  // IPv4 variants — including decimal int, hex int, octal, and any
  // dotted-quad form Node's URL parser accepted but the regex missed.
  const v4 = tryParseIPv4Variants(host)
  if (v4) {
    if (whitelist.length > 0 && ipInAnyCidr4(v4, whitelist)) return { ok: true }
    return checkIpv4Safety(v4)
  }

  // Not an IP literal — DNS hostname. Pass without resolution at this
  // layer; CR-2 (DNS-aware SSRF via custom http.Agent.lookup) is a
  // separate hardening track.
  return { ok: true }
}

/**
 * v1.2.70 — IPv4 parser that accepts every form Node's URL parser
 * also accepts:
 *   - dotted quad      "127.0.0.1"
 *   - 3-part           "127.1" (rare but valid per RFC 3986)
 *   - decimal integer  "2130706433"
 *   - hex integer      "0x7f000001" / "0x7f.0.0.1"
 *   - octal            "0177.0.0.1"
 * Returns the 4-octet form or null if the input isn't a valid IPv4
 * representation. Validates each octet's range, closing CR-3
 * (999.999.999.999 overflow) — any out-of-range part → null.
 */
export function tryParseIPv4Variants(host: string): [number, number, number, number] | null {
  // 1. canonical dotted quad with strict 0-255 range
  const dq = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (dq) {
    const o = [Number(dq[1]), Number(dq[2]), Number(dq[3]), Number(dq[4])]
    if (o.every((x) => x >= 0 && x <= 255)) return [o[0], o[1], o[2], o[3]]
    return null
  }
  // 2. one-to-four parts, each in decimal/hex/octal.
  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const numeric: number[] = []
  for (const p of parts) {
    const n = parseIntegerVariant(p)
    if (n === null) return null
    numeric.push(n)
  }
  // RFC 3986 §3.2.2 (Old-style URL parsers): expand the last part
  // across the remaining bytes. E.g. "127.1" → 127.0.0.1.
  if (numeric.length === 1) {
    const v = numeric[0]
    if (v < 0 || v > 0xffffffff) return null
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  }
  if (numeric.length === 2) {
    const a = numeric[0], rest = numeric[1]
    if (a < 0 || a > 255 || rest < 0 || rest > 0xffffff) return null
    return [a, (rest >>> 16) & 0xff, (rest >>> 8) & 0xff, rest & 0xff]
  }
  if (numeric.length === 3) {
    const [a, b, rest] = numeric
    if (a > 255 || b > 255 || rest < 0 || rest > 0xffff) return null
    return [a, b, (rest >>> 8) & 0xff, rest & 0xff]
  }
  // 4 parts → all must fit 0-255
  if (numeric.every((x) => x >= 0 && x <= 255)) {
    return [numeric[0], numeric[1], numeric[2], numeric[3]]
  }
  return null
}

/** Parse a single integer-form octet. Hex prefix 0x, octal prefix 0
 *  (only when followed by 0-7, else decimal). Returns null on invalid. */
function parseIntegerVariant(s: string): number | null {
  if (s.length === 0) return null
  if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s, 16)
  // octal: leading 0 followed by 1+ digits, ALL digits must be 0-7
  if (/^0[0-7]+$/.test(s)) return Number.parseInt(s, 8)
  if (/^[0-9]+$/.test(s)) return Number.parseInt(s, 10)
  return null
}

function checkIpv4Safety(octets: [number, number, number, number]): SafetyResult {
  const [a, b] = octets
  if (a === 10) return { ok: false, reason: 'RFC1918 10.0.0.0/8 private' }
  if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: 'RFC1918 172.16.0.0/12 private' }
  if (a === 192 && b === 168) return { ok: false, reason: 'RFC1918 192.168.0.0/16 private' }
  if (a === 127) return { ok: false, reason: '127.0.0.0/8 loopback' }
  if (a === 169 && b === 254) {
    return { ok: false, reason: '169.254.0.0/16 link-local (covers AWS/Azure IMDS 169.254.169.254)' }
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return {
      ok: false,
      reason: '100.64.0.0/10 carrier-grade NAT (whitelist via IMHUB_NATIVE_WEB_SSRF_WHITELIST=100.64.0.0/10 if intentional, e.g. Tailscale)',
    }
  }
  if (a === 0) return { ok: false, reason: '0.0.0.0/8 invalid' }
  return { ok: true }
}

/**
 * v1.2.70 — proper IPv6 safety check via numeric prefix parsing.
 * Replaces the ad-hoc regex that missed compressed forms
 * ("[fc::1]", "[fd00::]"). Uses the 16-bit groups returned by a
 * canonical expansion so the prefix bits actually drive the
 * decision.
 */
function checkIpv6Safety(addr: string): SafetyResult {
  const groups = expandIpv6(addr)
  if (!groups) return { ok: false, reason: `invalid IPv6 address: ${addr}` }
  // ::1 loopback
  if (groups.every((g, i) => (i < 7 ? g === 0 : g === 1))) {
    return { ok: false, reason: 'IPv6 loopback ::1' }
  }
  // fe80::/10 — first 10 bits are 1111 1110 10
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return { ok: false, reason: 'IPv6 link-local fe80::/10' }
  }
  // fc00::/7 — first 7 bits are 1111 110 (matches fc** and fd**)
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return { ok: false, reason: 'IPv6 ULA fc00::/7' }
  }
  // ::ffff:V4 — IPv4-mapped. Extract embedded v4 and re-check.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0
      && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const a = (groups[6] >>> 8) & 0xff
    const b = groups[6] & 0xff
    const c = (groups[7] >>> 8) & 0xff
    const d = groups[7] & 0xff
    return checkIpv4Safety([a, b, c, d])
  }
  // Unspecified ::
  if (groups.every((g) => g === 0)) {
    return { ok: false, reason: 'IPv6 unspecified ::' }
  }
  return { ok: true }
}

/** Expand `addr` (already validated by net.isIPv6) into 8 × 16-bit
 *  groups. Returns null only if the form somehow can't be normalized
 *  (shouldn't happen post-net.isIPv6).
 */
export function expandIpv6(addr: string): number[] | null {
  const lower = addr.toLowerCase()
  // Embedded IPv4 form like "::ffff:127.0.0.1"
  let working = lower
  const v4Tail = /([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/.exec(lower)
  if (v4Tail) {
    const v4 = tryParseIPv4Variants(v4Tail[1])
    if (!v4) return null
    const hex1 = ((v4[0] << 8) | v4[1]).toString(16)
    const hex2 = ((v4[2] << 8) | v4[3]).toString(16)
    working = lower.slice(0, v4Tail.index) + hex1 + ':' + hex2
  }
  const [head, tail] = working.split('::')
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail !== undefined ? (tail ? tail.split(':') : []) : null
  let groups: string[]
  if (tailGroups === null) {
    // No "::" present — must have exactly 8 groups
    if (headGroups.length !== 8) return null
    groups = headGroups
  } else {
    const missing = 8 - headGroups.length - tailGroups.length
    if (missing < 0) return null
    groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups]
  }
  const out: number[] = []
  for (const g of groups) {
    if (g === '' || g.length > 4 || !/^[0-9a-f]+$/.test(g)) return null
    out.push(Number.parseInt(g, 16))
  }
  if (out.length !== 8) return null
  return out
}

// v1.2.66 — CIDR whitelist parsing + IPv4-only matcher.
// Supports IPv4 CIDR only; IPv6 CIDR whitelist is rare enough to skip
// for now. Invalid entries are silently dropped.
interface Cidr4 { network: number; mask: number }

export function parseSsrfWhitelist(raw: string | undefined): Cidr4[] {
  if (!raw) return []
  const out: Cidr4[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(trimmed)
    if (!m) continue
    const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if (octets.some((o) => o < 0 || o > 255)) continue
    const prefix = Number(m[5])
    if (prefix < 0 || prefix > 32) continue
    const networkInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    out.push({ network: (networkInt & mask) >>> 0, mask })
  }
  return out
}

function ipInAnyCidr4(octets: number[], cidrs: Cidr4[]): boolean {
  const ip = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  for (const c of cidrs) {
    if (((ip & c.mask) >>> 0) === c.network) return true
  }
  return false
}

// ─── helpers ─────────────────────────────────────────────────────────

function ok(payload: unknown): DispatcherResult {
  return { text: JSON.stringify(payload, null, 2), isError: false, source: 'web' }
}

function err(msg: string): DispatcherResult {
  return { text: msg, isError: true, source: 'web' }
}

async function readCapped(res: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) {
    const t = await res.text()
    return t.length > cap
      ? { text: t.slice(0, cap), truncated: true }
      : { text: t, truncated: false }
  }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let out = ''
  let truncated = false
  while (out.length < cap) {
    const { value, done } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
    if (out.length >= cap) {
      out = out.slice(0, cap)
      truncated = true
      try { await reader.cancel() } catch { /* ignore */ }
      break
    }
  }
  out += decoder.decode()
  return { text: out, truncated }
}

function resolveTimeoutMs(): number {
  const raw = process.env.IMHUB_NATIVE_WEB_TIMEOUT_MS
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0 && n <= 120_000) return n
  }
  return DEFAULT_TIMEOUT_MS
}

async function raceTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function clampNumber(input: unknown, dflt: number, min: number, max: number): number {
  const n = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
