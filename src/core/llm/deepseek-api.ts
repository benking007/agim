// DeepSeek V4 beta / Responses surfaces that sit beside Chat Completions:
//   - FIM (`POST /completions` on beta base)
//   - Chat Prefix Completion (Chat Completions on beta + assistant.prefix)
//   - Responses API (`POST /responses` on main base; flash today, Pro soon)
//
// These are thin fetch wrappers — Agim Agent stays on chat/Anthropic by
// default; callers opt in via OpenAICompat helpers or llm-rpc.

import { LlmProviderError } from './provider-base.js'
import {
  DEEPSEEK_BETA_BASE,
  DEEPSEEK_OPENAI_BASE,
  withDeepSeekUserId,
} from './deepseek-compat.js'

export interface DeepSeekHttpAuth {
  apiKey: string
  /** Override base (defaults per call type). */
  baseUrl?: string
  extraHeaders?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface DeepSeekFimRequest {
  model: string
  prompt: string
  suffix?: string
  maxTokens?: number
  temperature?: number
  stop?: string | string[]
  userId?: string
}

export interface DeepSeekFimResult {
  text: string
  modelUsed: string
  finishReason?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export interface DeepSeekResponsesRequest {
  model: string
  input?: string | unknown[]
  instructions?: string
  maxOutputTokens?: number
  temperature?: number
  stream?: boolean
  /** OpenAI Responses `reasoning.effort` (DeepSeek supports effort). */
  reasoningEffort?: 'low' | 'high' | 'max' | 'none'
  tools?: unknown[]
  toolChoice?: unknown
  userId?: string
  /** Extra body fields (passthrough). */
  extra?: Record<string, unknown>
}

export interface DeepSeekResponsesResult {
  id?: string
  outputText: string
  status?: string
  modelUsed: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
  }
  raw: unknown
}

function resolveTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: signal ?? new AbortController().signal, cleanup: () => {} }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => ctrl.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

async function deepSeekPostJson(
  url: string,
  body: unknown,
  auth: DeepSeekHttpAuth,
): Promise<unknown> {
  const { signal, cleanup } = resolveTimeoutSignal(auth.signal, auth.timeoutMs ?? 120_000)
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'agim-cli/deepseek-api',
      ...(auth.extraHeaders ?? {}),
    }
    if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    const text = await resp.text()
    let json: unknown
    try { json = text ? JSON.parse(text) : {} } catch {
      throw new LlmProviderError('deepseek', `non-JSON response from ${url}: ${text.slice(0, 200)}`, {
        httpStatus: resp.status,
      })
    }
    if (!resp.ok) {
      throw new LlmProviderError(
        'deepseek',
        `HTTP ${resp.status} from ${url}: ${text.slice(0, 500)}`,
        { httpStatus: resp.status, transient: resp.status === 429 || resp.status >= 500 },
      )
    }
    return json
  } finally {
    cleanup()
  }
}

/** FIM completion (beta). Max output 4K per DeepSeek docs. */
export async function completeDeepSeekFim(
  auth: DeepSeekHttpAuth,
  req: DeepSeekFimRequest,
): Promise<DeepSeekFimResult> {
  const base = (auth.baseUrl || DEEPSEEK_BETA_BASE).replace(/\/+$/, '')
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    max_tokens: Math.min(4096, req.maxTokens ?? 128),
  }
  if (req.suffix != null) body.suffix = req.suffix
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.stop !== undefined) body.stop = req.stop
  const withUser = withDeepSeekUserId(body, req.userId)
  const json = await deepSeekPostJson(`${base}/completions`, withUser, auth) as {
    model?: string
    choices?: Array<{ text?: string; finish_reason?: string }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  return {
    text: json.choices?.[0]?.text ?? '',
    modelUsed: typeof json.model === 'string' ? json.model : req.model,
    finishReason: json.choices?.[0]?.finish_reason,
    usage: {
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
    },
  }
}

/**
 * Build a Chat Completions messages list for prefix completion: last
 * assistant message must include `prefix: true` and the request must hit
 * the beta base URL.
 */
export function withChatPrefixAssistant(
  messages: Array<Record<string, unknown>>,
  prefixContent: string,
): Array<Record<string, unknown>> {
  return [
    ...messages,
    { role: 'assistant', content: prefixContent, prefix: true },
  ]
}

/** Non-streaming Responses API call (flash today; Pro when DeepSeek enables it). */
export async function createDeepSeekResponse(
  auth: DeepSeekHttpAuth,
  req: DeepSeekResponsesRequest,
): Promise<DeepSeekResponsesResult> {
  const base = (auth.baseUrl || DEEPSEEK_OPENAI_BASE).replace(/\/+$/, '')
  const body: Record<string, unknown> = {
    model: req.model,
    ...(req.extra ?? {}),
  }
  if (req.input !== undefined) body.input = req.input
  if (req.instructions !== undefined) body.instructions = req.instructions
  if (req.maxOutputTokens !== undefined) body.max_output_tokens = req.maxOutputTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.stream) body.stream = true
  if (req.tools) body.tools = req.tools
  if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice
  if (req.reasoningEffort) {
    body.reasoning = { effort: req.reasoningEffort }
  }
  if (req.userId) body.user = req.userId

  if (req.stream) {
    throw new LlmProviderError(
      'deepseek',
      'createDeepSeekResponse does not stream; use stream:false or a dedicated SSE client',
    )
  }

  const json = await deepSeekPostJson(`${base}/responses`, body, auth) as {
    id?: string
    status?: string
    model?: string
    output_text?: string
    output?: Array<{
      type?: string
      content?: Array<{ type?: string; text?: string }>
    }>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
      output_tokens_details?: { reasoning_tokens?: number }
    }
  }

  let outputText = typeof json.output_text === 'string' ? json.output_text : ''
  if (!outputText && Array.isArray(json.output)) {
    const parts: string[] = []
    for (const item of json.output) {
      if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text)
      }
    }
    outputText = parts.join('')
  }

  return {
    id: json.id,
    status: json.status,
    outputText,
    modelUsed: typeof json.model === 'string' ? json.model : req.model,
    usage: {
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
      cachedTokens: json.usage?.input_tokens_details?.cached_tokens,
      reasoningTokens: json.usage?.output_tokens_details?.reasoning_tokens,
    },
    raw: json,
  }
}
