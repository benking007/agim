/**
 * llm-rpc — `mcp__agim__llm_complete` (+ FIM / Responses) for the local
 * Unix RPC bridge.
 *
 * Independent services (e.g. iFund) call this via `AGIM_RPC_STATIC_TOKEN`
 * to run a one-shot completion against a configured `llmBackends` name
 * (deepseek-v4-pro, …) without going through the agent loop.
 *
 * Registry is normally populated at `agim start` (`loadFromConfig`). We
 * lazily reload once from disk if the process has no providers yet
 * (tests / RPC-only smoke) — secrets changes still require restart.
 */

import { completeDeepSeekFim, createDeepSeekResponse } from './deepseek-api.js'
import {
  DEEPSEEK_OPENAI_BASE,
  hashDeepSeekUserId,
  isDeepSeekAnthropicBaseUrl,
} from './deepseek-compat.js'
import { OpenAICompatProvider } from './openai-compat-provider.js'
import type { ChatResult, LlmMessage } from './provider-base.js'
import {
  getAnyProvider,
  getBackendBindingByName,
  getProviderByName,
  loadFromConfig,
} from './registry.js'
import { isDeepSeekBaseUrl } from './presets.js'

export interface LlmCompleteArgs {
  backend: string
  system?: string
  messages: {
    role: 'system' | 'user' | 'assistant'
    content: string
    /** DeepSeek Chat Prefix Completion (beta): last assistant only. */
    prefix?: boolean
  }[]
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

export interface LlmFimArgs {
  backend: string
  prompt: string
  suffix?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  /** Optional platform/userId for hashed DeepSeek user_id. */
  platform?: string
  userId?: string
}

export type LlmFimResult =
  | { ok: true; result: { text: string; modelUsed: string; usage?: ChatResult['usage'] } }
  | { ok: false; error: string }

export interface LlmResponsesArgs {
  backend: string
  input?: string
  instructions?: string
  maxOutputTokens?: number
  temperature?: number
  reasoningEffort?: 'low' | 'high' | 'max' | 'none'
  timeoutMs?: number
  platform?: string
  userId?: string
}

export type LlmResponsesResult =
  | {
      ok: true
      result: {
        outputText: string
        modelUsed: string
        status?: string
        usage?: {
          inputTokens?: number
          outputTokens?: number
          cachedTokens?: number
          reasoningTokens?: number
        }
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
    const msg: LlmMessage = { role, content: m.content }
    if (role === 'assistant' && m.prefix === true) msg.prefix = true
    messages.push(msg)
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

/** DeepSeek FIM (beta). Requires an openai-compat DeepSeek backend. */
export async function handleLlmFimOp(args: LlmFimArgs): Promise<LlmFimResult> {
  if (!args?.backend?.trim() || typeof args.prompt !== 'string') {
    return { ok: false, error: 'backend and prompt are required' }
  }
  await ensureRegistryLoaded()
  const binding = getBackendBindingByName(args.backend.trim())
  const provider = getProviderByName(args.backend.trim())
  if (!binding || !provider?.isConfigured()) {
    return { ok: false, error: `backend not configured: ${args.backend}` }
  }
  if (binding.providerType !== 'openai-compat' || !isDeepSeekBaseUrl(binding.baseUrl)) {
    return { ok: false, error: 'llm_fim requires a DeepSeek openai-compat backend' }
  }
  try {
    const result = provider instanceof OpenAICompatProvider
      ? await provider.completeFim({
          prompt: args.prompt,
          suffix: typeof args.suffix === 'string' ? args.suffix : undefined,
          maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
          temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
          userId: hashDeepSeekUserId(args.platform, args.userId),
        }, { timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined })
      : await completeDeepSeekFim(
          { apiKey: binding.apiKey ?? '', baseUrl: undefined, timeoutMs: args.timeoutMs },
          {
            model: binding.model,
            prompt: args.prompt,
            suffix: args.suffix,
            maxTokens: args.maxTokens,
            temperature: args.temperature,
            userId: hashDeepSeekUserId(args.platform, args.userId),
          },
        )
    return {
      ok: true,
      result: {
        text: result.text,
        modelUsed: result.modelUsed,
        usage: result.usage,
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** DeepSeek / OpenAI Responses API. Opt-in via AGIM_RPC_ALLOWED_TOOLS. */
export async function handleLlmResponsesOp(args: LlmResponsesArgs): Promise<LlmResponsesResult> {
  if (!args?.backend?.trim()) {
    return { ok: false, error: 'backend is required' }
  }
  if (args.input == null && args.instructions == null) {
    return { ok: false, error: 'input or instructions is required' }
  }
  await ensureRegistryLoaded()
  const binding = getBackendBindingByName(args.backend.trim())
  const provider = getProviderByName(args.backend.trim())
  if (!binding || !provider?.isConfigured()) {
    return { ok: false, error: `backend not configured: ${args.backend}` }
  }
  if (binding.providerType !== 'openai-compat') {
    return { ok: false, error: 'llm_responses requires an openai-compat backend' }
  }
  if (isDeepSeekAnthropicBaseUrl(binding.baseUrl)) {
    return { ok: false, error: 'llm_responses is not available on the Anthropic DeepSeek dialect' }
  }
  try {
    const result = provider instanceof OpenAICompatProvider
      ? await provider.createResponse({
          input: args.input,
          instructions: args.instructions,
          maxOutputTokens: args.maxOutputTokens,
          temperature: args.temperature,
          reasoningEffort: args.reasoningEffort,
          userId: hashDeepSeekUserId(args.platform, args.userId),
        }, { timeoutMs: args.timeoutMs })
      : await createDeepSeekResponse(
          {
            apiKey: binding.apiKey ?? '',
            baseUrl: isDeepSeekBaseUrl(binding.baseUrl) ? DEEPSEEK_OPENAI_BASE : binding.baseUrl,
            timeoutMs: args.timeoutMs,
          },
          {
            model: binding.model,
            input: args.input,
            instructions: args.instructions,
            maxOutputTokens: args.maxOutputTokens,
            temperature: args.temperature,
            reasoningEffort: args.reasoningEffort,
            userId: hashDeepSeekUserId(args.platform, args.userId),
          },
        )
    return {
      ok: true,
      result: {
        outputText: result.outputText,
        modelUsed: result.modelUsed,
        status: result.status,
        usage: result.usage,
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
