/**
 * Vision routing — look-at-image turns go through a same-family
 * `call_agent` child (backend=vision), then the child's result is
 * appended onto the parent prompt. The parent model stays on its
 * text SKU and never receives image bytes.
 *
 * This is a router, not a prompt heuristic: the parent LLM does not
 * decide whether to spawn. Disable with AGIM_VISION_ROUTE=off.
 */

import { callAgentByName, type CallAgentResult } from '../../../core/a2a.js'
import { generateTraceId, logger as rootLogger } from '../../../core/logger.js'
import { isDeepSeekVisionModel } from '../../../core/llm/presets.js'
import type { RouteContext } from '../../../core/router.js'
import { resolveSubagentSpawn } from '../../../core/subagent.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { parsePromptMedia } from '../agim-agent-shared/index.js'

export const VISION_ROUTE_RESULT_START = '【识图结果】'
export const VISION_ROUTE_RESULT_END = '【识图结束】'
const VISION_BACKEND_ALIAS = 'vision'

export interface VisionRouteInput {
  prompt: string
  modelId: string
  callerAgent: string
  opts?: AgentSendOpts
  signal?: AbortSignal
}

export interface VisionRouteResult {
  /** Prompt the parent harness should send (original + child analysis). */
  parentPrompt: string
  ok: boolean
  error?: string
}

export interface VisionRouteDeps {
  resolveSpawn?: typeof resolveSubagentSpawn
  callAgent?: typeof callAgentByName
}

export function isVisionRouteEnabled(): boolean {
  const raw = (process.env.AGIM_VISION_ROUTE ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'off' && raw !== 'false' && raw !== 'no'
}

/** Dedicated vision SKUs still receive image bytes; everyone else routes. */
export function isDedicatedVisionModel(modelId: string | undefined | null): boolean {
  return isDeepSeekVisionModel(modelId)
}

export function shouldRouteVision(modelId: string, prompt: string): boolean {
  if (!isVisionRouteEnabled()) return false
  if (isDedicatedVisionModel(modelId)) return false
  if (prompt.includes(VISION_ROUTE_RESULT_START)) return false
  return parsePromptMedia(prompt).length > 0
}

export function applyVisionResultToPrompt(prompt: string, body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return prompt
  if (prompt.includes(VISION_ROUTE_RESULT_START)) return prompt
  return `${prompt}\n\n${VISION_ROUTE_RESULT_START}\n${trimmed}\n${VISION_ROUTE_RESULT_END}`
}

export function stripImageContentBlocks<T>(messages: T[]): T[] {
  let changed = false
  const next = messages.map((m) => {
    if (!m || typeof m !== 'object' || !('content' in m)) return m
    const content = (m as { content?: unknown }).content
    if (!Array.isArray(content)) return m
    const filtered = content.filter((block) => !(
      block
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'image'
    ))
    if (filtered.length === content.length) return m
    changed = true
    return { ...m, content: filtered } as T
  })
  return changed ? next : messages
}

function buildChildBrief(prompt: string, paths: string[]): string {
  return [
    'Objective: OCR and describe every attached image. Extract visible text, UI labels, chart/table values, and salient visual facts.',
    'Output format: structured markdown with ## OCR text, ## Description, ## Key facts. Cite each absolute path.',
    'Boundaries: do not call call_agent or ask the user questions. Do not edit files.',
    'Done-when: OCR + description are in your FINAL message.',
    '',
    ...paths.map((p) => `[图片附件：${p}]`),
    '',
    'Parent user message (context only):',
    prompt.trim(),
  ].join('\n')
}

function visionFailMessage(error: string): string {
  return `识图子代理未能完成：${error.trim() || 'unknown error'}`
}

export async function runVisionRoute(
  input: VisionRouteInput,
  deps: VisionRouteDeps = {},
): Promise<VisionRouteResult> {
  const media = parsePromptMedia(input.prompt)
  if (media.length === 0) {
    return { parentPrompt: input.prompt, ok: true }
  }

  const resolveSpawn = deps.resolveSpawn ?? resolveSubagentSpawn
  const callAgent = deps.callAgent ?? callAgentByName
  const spawn = resolveSpawn(
    { agent: 'agim', backend: VISION_BACKEND_ALIAS, isolate: true },
    input.callerAgent,
  )
  if (!spawn.ok) {
    const error = spawn.error
    return {
      parentPrompt: applyVisionResultToPrompt(input.prompt, visionFailMessage(error)),
      ok: false,
      error,
    }
  }

  const opts = input.opts
  const routeCtx: RouteContext = {
    platform: opts?.platform || 'web',
    channelId: opts?.channelId || '',
    threadId: opts?.threadId || 'vision-route',
    defaultAgent: 'agim',
    userId: opts?.userId,
    traceId: opts?.traceId || generateTraceId(),
    logger: rootLogger.child({ component: 'vision-route' }),
    ...(opts?.onToolActivity ? { onToolActivity: opts.onToolActivity } : {}),
  }

  let result: CallAgentResult
  try {
    result = await callAgent(
      spawn.agent,
      buildChildBrief(input.prompt, media.map((m) => m.path)),
      routeCtx,
      {
        callerAgent: input.callerAgent,
        callerDepth: opts?.callDepth ?? 0,
        ...(typeof opts?.parentJobId === 'number' ? { parentJobId: opts.parentJobId } : {}),
        isolate: true,
        ...(spawn.model ? { model: spawn.model } : {}),
        activityLabel: spawn.label,
        activityStepId: `vision-route-${Date.now()}`,
        ...(opts?.onToolActivity ? { onToolActivity: opts.onToolActivity } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return {
      parentPrompt: applyVisionResultToPrompt(input.prompt, visionFailMessage(error)),
      ok: false,
      error,
    }
  }

  if (!result.ok) {
    const error = result.error || 'vision subagent failed'
    return {
      parentPrompt: applyVisionResultToPrompt(input.prompt, visionFailMessage(error)),
      ok: false,
      error,
    }
  }

  const text = typeof result.result === 'string' ? result.result.trim() : ''
  if (!text) {
    return {
      parentPrompt: applyVisionResultToPrompt(input.prompt, visionFailMessage('empty result')),
      ok: false,
      error: 'empty result',
    }
  }

  return {
    parentPrompt: applyVisionResultToPrompt(input.prompt, text),
    ok: true,
  }
}
