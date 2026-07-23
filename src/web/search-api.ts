// search-api — web_search provider introspection + ping.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   GET  /api/search/providers   → list all registered providers + chain — admin only
//   POST /api/search/test        → one-shot provider test query           — admin only

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError } from './http-utils.js'
import { requireAdmin } from './auth.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleSearchApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/search/providers' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleSearchProviders(req, res); return true
  }
  if (p === '/api/search/test' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleSearchTest(req, res); return true
  }
  return false
}

/** GET /api/search/providers — list every registered web_search
 *  backend with its env-key requirement, current availability, and
 *  the resolved chain. */
async function handleSearchProviders(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const { listAllSearchProviders, resolveSearchProviderChain } =
      await import('../core/llm/web-dispatcher.js')
    const providers = listAllSearchProviders()
    const chain = resolveSearchProviderChain().map((p) => p.name)
    sendJson(res, 200, { providers, chain })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

/** POST /api/search/test — `{ provider, query }`. Sends a one-shot
 *  query through a single provider and returns `{ ok, latencyMs, hits, error? }`. */
async function handleSearchTest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { provider?: string; query?: string }
    const provider = (parsed.provider || '').trim()
    const query = (parsed.query || '').trim()
    if (!provider) {
      sendError(res, 400, 'SEARCH_TEST_PROVIDER_REQUIRED', { message: 'provider required' })
      return
    }
    if (!query) {
      sendError(res, 400, 'SEARCH_TEST_QUERY_REQUIRED', { message: 'query required' })
      return
    }
    const { getSearchProviderByName } = await import('../core/llm/web-dispatcher.js')
    const p = getSearchProviderByName(provider)
    if (!p) {
      sendError(res, 400, 'SEARCH_TEST_UNKNOWN_PROVIDER', {
        message: `unknown provider "${provider}"`,
      })
      return
    }
    if (!p.available()) {
      sendJson(res, 200, {
        ok: false, provider, latencyMs: 0, hits: 0,
        error: 'provider is not available (missing key?)',
      })
      return
    }
    const controller = new AbortController()
    const tm = setTimeout(() => controller.abort(), 10_000)
    const t0 = Date.now()
    try {
      const hits = await p.search(query, 3, controller.signal)
      sendJson(res, 200, {
        ok: true, provider, latencyMs: Date.now() - t0, hits: hits.length,
      })
    } catch (err) {
      sendJson(res, 200, {
        ok: false, provider, latencyMs: Date.now() - t0, hits: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      clearTimeout(tm)
    }
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
