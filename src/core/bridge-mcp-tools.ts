// In-process MCP adapter for bridge runs.
//
// The three tools call the existing bridge run path. events/* manage
// subscriptions. There is no OAuth here: tests pass the mcp_events peer.
// The HTTP route refuses the bridge token.

import type { BridgePeer } from './bridge-peers.js'
import {
  listMcpEvents,
  subscribeMcpEvent,
  unsubscribeMcpEvent,
  type McpPostOptions,
  type SubscribeInput,
} from './bridge-mcp-events.js'
import {
  acceptBridgeRun,
  BRIDGE_PROMPT_MAX_CODE_POINTS,
  bridgeWorkspacePinned,
  clampBridgeTimeoutMs,
  codePointLength,
  getBridgeRunByRunId,
  startBridgeRun,
} from './bridge-run.js'
import { abortChildJobsForParentTurn, cancelJob, createJob, getJob } from './job-board.js'

const IDEMPOTENCY = /^[\u0020-\u007e]{1,128}$/

export interface McpToolError {
  ok: false
  code: number
  message: string
  reason?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function agimCreateRun(peer: BridgePeer, raw: unknown): { ok: true; result: Record<string, unknown> } | McpToolError {
  const body = asRecord(raw) ?? {}
  if ('callbackUrl' in body || 'callback' in body || 'webhook' in body) {
    return { ok: false, code: -32602, message: 'callback URL is not part of create' }
  }
  if (body.agent !== 'agim') return { ok: false, code: -32602, message: 'agent must be agim' }
  if (typeof body.prompt !== 'string' || codePointLength(body.prompt) === 0 || codePointLength(body.prompt) > BRIDGE_PROMPT_MAX_CODE_POINTS) {
    return { ok: false, code: -32602, message: 'prompt is required' }
  }
  if (typeof body.timeoutMs !== 'number' || !Number.isInteger(body.timeoutMs) || body.timeoutMs <= 0) {
    return { ok: false, code: -32602, message: 'timeoutMs must be a positive integer' }
  }
  if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY.test(body.idempotencyKey)) {
    return { ok: false, code: -32602, message: 'idempotencyKey must be 1–128 visible ASCII characters' }
  }
  let correlationId: string | null = null
  if (body.correlationId !== undefined) {
    if (typeof body.correlationId !== 'string' || codePointLength(body.correlationId) > 128) {
      return { ok: false, code: -32602, message: 'correlationId is too long' }
    }
    correlationId = body.correlationId.length > 0 ? body.correlationId : null
  }
  if (!peer.agents.includes('agim')) return { ok: false, code: -32024, message: 'agent is not allowed for this caller' }
  if (!bridgeWorkspacePinned(peer.peerId, peer.workspaceId)) {
    return { ok: false, code: -32024, message: 'workspace is not pinned' }
  }
  const accepted = acceptBridgeRun({
    peer,
    agent: 'agim',
    prompt: body.prompt,
    idempotencyKey: body.idempotencyKey,
    correlationId,
    timeoutMs: clampBridgeTimeoutMs(body.timeoutMs),
    createJob: (agent, prompt, jobOpts) => createJob(agent, prompt, jobOpts),
  })
  if (accepted.created) startBridgeRun(accepted.job.id)
  return {
    ok: true,
    result: {
      runId: accepted.row.run_id,
      jobId: accepted.row.job_id,
      status: accepted.job.status,
      agent: accepted.job.agent,
    },
  }
}

export function agimGetRun(peer: BridgePeer, raw: unknown): { ok: true; result: Record<string, unknown> } | McpToolError {
  const body = asRecord(raw) ?? {}
  if (typeof body.runId !== 'string' || !body.runId) return { ok: false, code: -32602, message: 'runId is required' }
  const row = getBridgeRunByRunId(body.runId)
  if (!row || row.peer_id !== peer.peerId || row.direction !== 'inbound') {
    return { ok: false, code: -32001, message: 'run not found' }
  }
  const job = getJob(row.job_id)
  if (!job) return { ok: false, code: -32001, message: 'run not found' }
  return {
    ok: true,
    result: {
      runId: row.run_id,
      jobId: row.job_id,
      status: job.status,
      agent: job.agent,
      result: job.result,
      error: job.error,
    },
  }
}

export function agimCancelRun(peer: BridgePeer, raw: unknown): { ok: true; result: Record<string, unknown> } | McpToolError {
  const body = asRecord(raw) ?? {}
  if (typeof body.runId !== 'string' || !body.runId) return { ok: false, code: -32602, message: 'runId is required' }
  const row = getBridgeRunByRunId(body.runId)
  if (!row || row.peer_id !== peer.peerId || row.direction !== 'inbound') {
    return { ok: false, code: -32001, message: 'run not found' }
  }
  const job = getJob(row.job_id)
  if (!job) return { ok: false, code: -32001, message: 'run not found' }
  if (job.status === 'pending' || job.status === 'running') {
    cancelJob(row.job_id)
    abortChildJobsForParentTurn('bridge', row.peer_id, `bridge-${row.run_id}`)
  }
  return { ok: true, result: { ok: true } }
}

export const MCP_BRIDGE_TOOLS = [
  {
    name: 'agim_create_run',
    description: 'Create a bridge run for agent agim. The full result is read with agim_get_run.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        prompt: { type: 'string' },
        timeoutMs: { type: 'integer' },
        idempotencyKey: { type: 'string' },
        correlationId: { type: 'string' },
      },
      required: ['agent', 'prompt', 'timeoutMs', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'agim_get_run',
    description: 'Read a bridge run, including the full result text.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agim_cancel_run',
    description: 'Cancel a bridge run.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
] as const

export async function dispatchBridgeMcp(
  method: string,
  params: unknown,
  ctx: { peer: BridgePeer },
  opts: McpPostOptions = {},
): Promise<{ ok: true; result: unknown } | McpToolError> {
  if (method === 'events/list') return { ok: true, result: listMcpEvents() }
  if (method === 'events/subscribe') {
    const subscribed = await subscribeMcpEvent((params ?? {}) as SubscribeInput, opts)
    if (!subscribed.ok) return subscribed
    return {
      ok: true,
      result: { id: subscribed.id, refreshBefore: subscribed.refreshBefore, cursor: null, truncated: false },
    }
  }
  if (method === 'events/unsubscribe') {
    const removed = unsubscribeMcpEvent((params ?? {}) as SubscribeInput)
    if (!removed.ok) return removed
    return { ok: true, result: {} }
  }
  if (method === 'tools/list') return { ok: true, result: { tools: MCP_BRIDGE_TOOLS } }
  if (method === 'tools/call') {
    const rec = asRecord(params)
    const name = rec && typeof rec.name === 'string' ? rec.name : ''
    const args = rec?.arguments
    if (name === 'agim_create_run') return agimCreateRun(ctx.peer, args)
    if (name === 'agim_get_run') return agimGetRun(ctx.peer, args)
    if (name === 'agim_cancel_run') return agimCancelRun(ctx.peer, args)
    return { ok: false, code: -32602, message: 'unknown tool' }
  }
  return { ok: false, code: -32601, message: 'method not found' }
}
