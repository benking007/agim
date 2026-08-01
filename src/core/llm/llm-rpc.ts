/**
 * llm-rpc — `mcp__agim__llm_complete` handler for the local Unix RPC bridge.
 *
 * Independent services (e.g. iFund) call this via `AGIM_RPC_STATIC_TOKEN`
 * to run a one-shot completion against a configured `llmBackends` name
 * (deepseek-v4-pro, …) without going through the agent loop.
 *
 * Registry is normally populated at `agim start` (`loadFromConfig`). We
 * lazily reload once from disk if the process has no providers yet
 * (tests / RPC-only smoke) — secrets changes still require restart.
 */

import type { ChatResult, LlmMessage } from './provider-base.js'
import {
  getAnyProvider,
  getProviderByName,
  loadFromConfig,
} from './registry.js'

export interface LlmCompleteArgs {
  backend: string
  system?: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

export type LlmCompleteResult =
  | {
      ok: true
      result: {
        text: string
        finishReason: ChatResult['finishReason']
        usage: ChatResult['usage']
      }
    }
  | { ok: false; error: string }

let registryEnsure: Promise<void> | null = null

async function ensureRegistryLoaded(): Promise<void> {
  if (getAnyProvider()) return
  if (!registryEnsure) {
    registryEnsure = (async () => {
      const { loadConfig } = await import('../onboarding.js')
      const cfg = await loadConfig()
      loadFromConfig(cfg)
    })().catch((err) => {
      registryEnsure = null
      throw err
    })
  }
  await registryEnsure
}

/** Test helper — drop the lazy-load latch so the next call re-reads config. */
export function _resetLlmRpcRegistryLatchForTests(): void {
  registryEnsure = null
}

export async function handleLlmOp(args: LlmCompleteArgs): Promise<LlmCompleteResult> {
  if (!args?.backend || typeof args.backend !== 'string' || !args.backend.trim()) {
    return { ok: false, error: 'backend and messages are required' }
  }
  if (!Array.isArray(args.messages) || args.messages.length === 0) {
    return { ok: false, error: 'backend and messages are required' }
  }

  await ensureRegistryLoaded()
  const provider = getProviderByName(args.backend.trim())
  if (!provider || !provider.isConfigured()) {
    return { ok: false, error: `backend not configured: ${args.backend}` }
  }

  const messages: LlmMessage[] = []
  for (const m of args.messages) {
    if (!m || typeof m !== 'object') {
      return { ok: false, error: 'each message needs role and content' }
    }
    const role = m.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { ok: false, error: `invalid message role: ${String(role)}` }
    }
    if (typeof m.content !== 'string') {
      return { ok: false, error: 'each message needs role and content' }
    }
    messages.push({ role, content: m.content })
  }

  try {
    const result = await provider.chat(messages, {
      system: typeof args.system === 'string' ? args.system : undefined,
      temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
      maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
    })
    return {
      ok: true,
      result: {
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
