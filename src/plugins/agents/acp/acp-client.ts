// ACP HTTP client — communicates with remote ACP-compatible agents
//
// ACP convention for endpoint paths (per OpenAPI spec):
//   GET  /agent/card    → Agent Manifest
//   POST /tasks         → Create task (sync or stream)
//   GET  /tasks/{id}    → Get task status
//
// The user provides the base URL. We append these standard paths.

import type { ChatMessage } from '../../../core/types.js'
import type { ACPAgentConfig, ACPManifest, ACPCreateTaskRequest, ACPTaskResponse } from './types.js'

/**
 * Build auth headers from ACP config. Extracted as a shared helper
 * so both ACPClient and CLI config validation use the same logic.
 */
export function buildAuthHeaders(config: { auth?: ACPAgentConfig['auth'] }): Record<string, string> | undefined {
  if (!config.auth || config.auth.type === 'none') return undefined
  if (!config.auth.token) return undefined
  if (config.auth.type === 'bearer') return { Authorization: `Bearer ${config.auth.token}` }
  if (config.auth.type === 'apikey') return { 'X-API-Key': config.auth.token }
  return undefined
}

/** Merge caller abort with the hard timeout. Node 22+ provides AbortSignal.any. */
export function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s)
  if (list.length === 0) return AbortSignal.timeout(300_000)
  const first = list[0]
  if (list.length === 1 && first) return first
  return AbortSignal.any(list)
}

export class ACPClient {
  private baseUrl: string
  private authHeaders?: Record<string, string>
  private manifest?: ACPManifest

  constructor(config: ACPAgentConfig) {
    this.baseUrl = config.endpoint.replace(/\/$/, '')
    this.authHeaders = buildAuthHeaders(config)
  }

  /** Fetch and cache the Agent Manifest (GET /agent/card) */
  async fetchManifest(): Promise<ACPManifest> {
    const res = await fetch(`${this.baseUrl}/agent/card`, {
      headers: { ...this.authHeaders, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
      // SSRF defence-in-depth — see discovery.ts:75 for context. Tasks
      // posted later (`runTaskSync` / `runTaskStream`) share this
      // posture so a saved-but-malicious agent URL can't redirect into
      // private space mid-call.
      redirect: 'manual',
    })

    if (!res.ok) {
      throw new Error(`Failed to fetch manifest: ${res.status} ${res.statusText}`)
    }

    this.manifest = (await res.json()) as ACPManifest
    return this.manifest
  }

  /** Check if the agent endpoint is reachable */
  async healthCheck(): Promise<boolean> {
    try {
      const manifest = await this.fetchManifest()
      return !!manifest.name
    } catch {
      return false
    }
  }

  /**
   * Send prompt and stream response chunks via SSE.
   * Parses Server-Sent Events per the W3C spec:
   * - Multiple `data:` lines for a single event are joined with newlines
   * - Events separated by blank lines
   *
   * `sessionId` is forwarded as `session_id` in the request body so the
   * remote agent can persist context across turns (P2-C).
   * `signal` aborts the underlying fetch (merged with the 5min hard timeout).
   */
  async *streamPrompt(
    prompt: string,
    history?: ChatMessage[],
    sessionId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const body: ACPCreateTaskRequest = {
      input: {
        prompt,
        history: history?.map((m) => ({ role: m.role, content: m.content })),
      },
      mode: 'stream',
      ...(sessionId ? { session_id: sessionId } : {}),
    }

    const res = await fetch(`${this.baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(body),
      signal: mergeAbortSignals(AbortSignal.timeout(300000), signal),
      redirect: 'manual',
    })

    if (!res.ok) {
      const errorBody = await res.text().catch(() => 'unknown error')
      throw new Error(`ACP task failed: ${res.status} ${errorBody}`)
    }

    // Parse SSE stream (W3C spec compliant)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body for streaming')

    const decoder = new TextDecoder()
    let buffer = ''
    let eventDataLines: string[] = []

    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {})
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('This operation was aborted', 'AbortError')
        }
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete lines
        while (true) {
          const newlineIdx = buffer.indexOf('\n')
          if (newlineIdx === -1) break
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, '')
          buffer = buffer.slice(newlineIdx + 1)

          if (line === '') {
            // Empty line = end of event. Process accumulated data.
            if (eventDataLines.length > 0) {
              const data = eventDataLines.join('\n')
              eventDataLines = []

              if (data === '[DONE]') return

              try {
                const event = JSON.parse(data)
                if (event.output?.content) {
                  yield event.output.content
                } else if (event.error) {
                  throw new Error(`ACP error: ${event.error.message}`)
                }
              } catch (e) {
                if (e instanceof SyntaxError) continue
                throw e
              }
            }
          } else if (line.startsWith('data: ')) {
            eventDataLines.push(line.slice(6))
          } else if (line.startsWith('data:')) {
            eventDataLines.push(line.slice(5).trimStart())
          }
          // Ignore comment lines (starting with ':') and other SSE fields
        }
      }

      // Process any remaining data in buffer
      if (eventDataLines.length > 0) {
        const data = eventDataLines.join('\n')
        if (data !== '[DONE]') {
          try {
            const event = JSON.parse(data)
            if (event.output?.content) yield event.output.content
          } catch {
            /* ignore trailing malformed data */
          }
        }
      }
    } finally {
      try { reader.releaseLock() } catch { /* already released */ }
    }
  }

  /** Send prompt and wait for complete response (non-streaming fallback) */
  async sendPromptSync(
    prompt: string,
    history?: ChatMessage[],
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const body: ACPCreateTaskRequest = {
      input: {
        prompt,
        history: history?.map((m) => ({ role: m.role, content: m.content })),
      },
      mode: 'sync',
      ...(sessionId ? { session_id: sessionId } : {}),
    }

    const res = await fetch(`${this.baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(body),
      signal: mergeAbortSignals(AbortSignal.timeout(300000), signal),
      redirect: 'manual',
    })

    if (!res.ok) {
      throw new Error(`ACP task failed: ${res.status}`)
    }

    const task = (await res.json()) as ACPTaskResponse
    return task.output?.content || ''
  }
}
