// ACPAdapter — bridges ACP protocol to IM-Hub's AgentAdapter interface.
//
// P2-C: sessionId is now forwarded to the remote agent in the request body
// (as `session_id`) so multi-turn conversations preserve context across
// HTTP calls. Remote agents that don't recognize the field simply ignore
// it; this is a forward-compatible spec extension.

import type { AgentAdapter, AgentSendOpts, ChatMessage } from '../../../core/types.js'
import type { ACPAgentConfig, ACPManifest } from './types.js'
import { ACPClient } from './acp-client.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'acp-adapter' })

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

export class ACPAdapter implements AgentAdapter {
  readonly name: string
  readonly aliases: string[]
  readonly kind = 'remote' as const
  private client: ACPClient
  private endpoint: string

  constructor(config: ACPAgentConfig) {
    this.name = config.name
    this.aliases = config.aliases || []
    this.endpoint = config.endpoint
    this.client = new ACPClient(config)
  }

  describe(): string | undefined {
    try {
      const u = new URL(this.endpoint)
      return `host: ${u.host}`
    } catch {
      return this.endpoint || undefined
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.client.healthCheck()
  }

  async *sendPrompt(
    sessionId: string,
    prompt: string,
    history?: ChatMessage[],
    opts?: AgentSendOpts,
  ): AsyncGenerator<string> {
    let outcomeReported = false
    const reportOutcome = (outcome: Parameters<NonNullable<AgentSendOpts['onOutcome']>>[0]) => {
      if (outcomeReported) return
      outcomeReported = true
      try { opts?.onOutcome?.(outcome) } catch { /* observer isolation */ }
    }

    if (opts?.signal?.aborted) {
      reportOutcome({ status: 'aborted', providerFailure: false })
      return
    }

    // Try streaming first, fall back to sync.
    // NOTE: Fallback creates a new task; if the streaming task was partially
    // processed, the agent may repeat work. Acceptable for v1.
    // ACP wire protocol does not yet expose token usage — leave onUsage unused.
    try {
      for await (const chunk of this.client.streamPrompt(prompt, history, sessionId, opts?.signal)) {
        if (opts?.signal?.aborted) {
          reportOutcome({ status: 'aborted', providerFailure: false })
          return
        }
        yield chunk
      }
      reportOutcome({ status: 'success', providerFailure: false })
    } catch (streamError) {
      if (opts?.signal?.aborted || isAbortError(streamError)) {
        reportOutcome({ status: 'aborted', providerFailure: false })
        return
      }
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError)
      log.warn({ agent: this.name, error: errMsg, sessionId },
        'ACP streaming failed, falling back to sync')
      try {
        const response = await this.client.sendPromptSync(prompt, history, sessionId, opts?.signal)
        if (opts?.signal?.aborted) {
          reportOutcome({ status: 'aborted', providerFailure: false })
          return
        }
        if (response) yield response
        reportOutcome({ status: 'success', providerFailure: false })
      } catch (syncError) {
        if (opts?.signal?.aborted || isAbortError(syncError)) {
          reportOutcome({ status: 'aborted', providerFailure: false })
          return
        }
        const msg = syncError instanceof Error ? syncError.message : String(syncError)
        reportOutcome({ status: 'error', providerFailure: true, error: msg })
        throw syncError
      }
    }
  }

  /** Get the agent manifest for display (not part of AgentAdapter interface) */
  async getManifest(): Promise<ACPManifest | undefined> {
    try {
      return await this.client.fetchManifest()
    } catch {
      return undefined
    }
  }
}
