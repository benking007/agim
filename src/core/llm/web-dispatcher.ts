// web-dispatcher — read-only web tools for the native agent (v1.2.61).
//
// Two tools shipped:
//   - native_web_fetch(url, format?)   GET + optional Jina Reader text extract
//   - native_web_search(query, n?)     duckduckgo HTML scrape, metaso fallback
//
// Both have:
//   * 30s default per-call timeout (override via IMHUB_NATIVE_WEB_TIMEOUT_MS)
//   * SSRF block — RFC1918 / localhost / link-local are denied unless
//     IMHUB_NATIVE_WEB_ALLOW_PRIVATE=1
//   * Body / result size cap to keep the model context manageable
//
// Backend selection for web_search:
//   1. duckduckgo  — primary, no API key, scrapes the HTML SERP
//   2. metaso      — fallback when ddg returns 0/error, uses METASO_API_KEY
//
// Both tools are read-only and safe to default-allow in native's policy.

import { logger as rootLogger } from '../logger.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'

const log = rootLogger.child({ component: 'web-dispatcher' })

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_FETCH_MAX_BYTES = 200 * 1024  // 200 KB after extract
const DEFAULT_SEARCH_RESULTS = 8
const DDG_SEARCH_URL = 'https://duckduckgo.com/html/?q='
const METASO_API_BASE = 'https://metaso.cn/api/v1'  // adapt if path differs
const JINA_READER_BASE = 'https://r.jina.ai/'

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
        'Backend chain: DuckDuckGo HTML (no key) → Metaso fallback (needs METASO_API_KEY).',
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

async function runWebSearch(args: Record<string, unknown>, signal: AbortSignal): Promise<DispatcherResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { text: 'query required', isError: true, source: 'web' }
  const n = clampNumber(args.n, DEFAULT_SEARCH_RESULTS, 1, 20)
  // 1) DuckDuckGo first.
  try {
    const ddg = await searchDuckDuckGo(query, n, signal)
    if (ddg.length > 0) {
      return ok({ query, backend: 'duckduckgo', count: ddg.length, results: ddg })
    }
    log.info({ event: 'web.search.ddg_empty', query }, 'duckduckgo returned 0 results, falling back to metaso')
  } catch (err) {
    log.warn({ event: 'web.search.ddg_failed', err: errMsg(err) })
  }
  // 2) Metaso fallback.
  try {
    const meta = await searchMetaso(query, n, signal)
    if (meta.length > 0) {
      return ok({ query, backend: 'metaso', count: meta.length, results: meta })
    }
    return err('web_search: both duckduckgo and metaso returned no results')
  } catch (err2) {
    return err(`web_search: ddg failed and metaso fallback failed: ${errMsg(err2)}`)
  }
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

  // v1.2.66 — CIDR whitelist. Operator-set ranges escape the
  // private-IP block. Use case: Tailscale (100.64.0.0/10), internal
  // VPN subnets, OpenAI-compat services on internal docker networks.
  // Format: `IMHUB_NATIVE_WEB_SSRF_WHITELIST=10.20.0.0/16,100.64.0.0/10`.
  // Parsed once per call (cheap; called per fetch); cache could be
  // added but the list is small and changes are rare.
  const whitelist = parseSsrfWhitelist(process.env.IMHUB_NATIVE_WEB_SSRF_WHITELIST)

  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost is private (set IMHUB_NATIVE_WEB_ALLOW_PRIVATE=1 or whitelist via IMHUB_NATIVE_WEB_SSRF_WHITELIST)' }
  }
  // IPv4 numeric check
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (whitelist.length > 0 && octets.every((o) => Number.isFinite(o) && o >= 0 && o <= 255)
        && ipInAnyCidr4(octets, whitelist)) {
      return { ok: true }
    }
    const [a, b] = [octets[0], octets[1]]
    if (a === 10) return { ok: false, reason: 'RFC1918 10.0.0.0/8 private' }
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: 'RFC1918 172.16.0.0/12 private' }
    if (a === 192 && b === 168) return { ok: false, reason: 'RFC1918 192.168.0.0/16 private' }
    if (a === 127) return { ok: false, reason: '127.0.0.0/8 loopback' }
    if (a === 169 && b === 254) return { ok: false, reason: '169.254.0.0/16 link-local (covers AWS/Azure IMDS 169.254.169.254)' }
    // v1.2.66 — Carrier-grade NAT (RFC 6598). Cloud providers + some
    // ISPs use this for internal-only hosts. Not "private" in the
    // RFC1918 sense but routinely used as such; nanobot blocks it.
    if (a === 100 && b >= 64 && b <= 127) {
      return { ok: false, reason: '100.64.0.0/10 carrier-grade NAT (whitelist via IMHUB_NATIVE_WEB_SSRF_WHITELIST=100.64.0.0/10 if intentional, e.g. Tailscale)' }
    }
    if (a === 0) return { ok: false, reason: '0.0.0.0/8 invalid' }
  }
  // IPv6 — Node's URL.hostname keeps the brackets ("[fe80::1]"). Strip
  // for prefix matching. Block link-local (fe80::/10) and ULA
  // (fc00::/7 — covers fc**/fd**). Also block ::1 loopback.
  const v6 = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (v6 === '::1') return { ok: false, reason: 'IPv6 loopback ::1' }
  if (v6.startsWith('fe80:') || v6.startsWith('fe80::')) {
    return { ok: false, reason: 'IPv6 link-local fe80::/10' }
  }
  if (v6.startsWith('fc') || v6.startsWith('fd')) {
    if (/^f[cd][0-9a-f]{2}:/i.test(v6)) {
      return { ok: false, reason: 'IPv6 ULA fc00::/7' }
    }
  }
  return { ok: true }
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
