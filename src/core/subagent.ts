// Subagent spawn helpers — same-family (agim + role/backend) and
// cross-adapter targets share one resolution path before A2A / activity.
// Concept SSOT: docs/architecture/subagent.md

import { AGIM_AGENT_ID, isAgimAgentId, normalizeAgentId } from './naming-migrate.js'
import { registry } from './registry.js'
import {
  describeRegistry,
  getBackendBindingByName,
  getBackendBindingForRole,
  getProviderByName,
  listProviders,
} from './llm/registry.js'
import { canonicalizeToolName, expandToolNameList } from './llm/tool-names.js'

export interface ParsedCallAgentTarget {
  agent: string
  role?: string
  backend?: string
  isolate?: boolean
}

/**
 * Normalize model-supplied call_agent `agent` strings.
 *
 * Preferred concrete form is backend name (llmBackends.name), not role:
 * roles like `cheap` are optional aliases and often unset.
 *
 * - `agim` / `native` → agim
 * - `agim/native` → agim + isolate (default model)
 * - `agim/<name>` / `agim:<name>` → backend if configured, else role if bound
 * - legacy `agim/native` slash form kept for old schema copy
 */
export function parseCallAgentTarget(raw: string): ParsedCallAgentTarget {
  const trimmed = raw.trim()
  if (!trimmed) return { agent: '' }

  const slash = trimmed.indexOf('/')
  const colon = trimmed.indexOf(':')
  let head = ''
  let tail = ''
  if (slash > 0) {
    head = trimmed.slice(0, slash).trim()
    tail = trimmed.slice(slash + 1).trim()
  } else if (colon > 0) {
    head = trimmed.slice(0, colon).trim()
    tail = trimmed.slice(colon + 1).trim()
  }

  if (head && isAgimAgentId(head)) {
    if (!tail || tail === 'native' || tail === 'agim') {
      return { agent: AGIM_AGENT_ID, isolate: true }
    }
    // Prefer concrete backend name; fall back to llmRoles alias.
    const asBackend = resolveBackendName(tail)
    if (asBackend) {
      return { agent: AGIM_AGENT_ID, backend: asBackend, isolate: true }
    }
    if (getBackendBindingForRole(tail)) {
      return { agent: AGIM_AGENT_ID, role: tail, isolate: true }
    }
    // Neither configured — keep as backend so the error lists real backends.
    return { agent: AGIM_AGENT_ID, backend: tail, isolate: true }
  }

  if (isAgimAgentId(trimmed)) return { agent: AGIM_AGENT_ID }
  return { agent: normalizeAgentId(trimmed) || trimmed }
}

export interface SubagentSpawnInput {
  agent: string
  /** llmRoles key, e.g. `cheap` → flash (optional alias; prefer backend). */
  role?: string
  /** Explicit llmBackends name (preferred same-family pin). */
  backend?: string
  /** Allow same-agent nested spawn with isolated context (same or default model). */
  isolate?: boolean
}

/** Keys accepted on a native `call_agent` / `call_agents` task object. */
export const CALL_AGENT_TASK_KEYS = [
  'agent',
  'prompt',
  'role',
  'backend',
  'isolate',
  'outputFormat',
  'maxDepth',
  'allowedTools',
] as const

/** Extra keys the CLI MCP / PI bus payload may carry. */
export const CALL_AGENT_CLI_EXTRA_KEYS = ['timeoutMs', 'inputs', 'expectOutputs'] as const

export const CALL_AGENTS_ROOT_KEYS = ['tasks'] as const

export interface ParsedCallAgentTask {
  agent: string
  prompt: string
  role?: string
  backend?: string
  isolate?: boolean
  outputFormat?: string
  /** Absolute subtree depth ceiling (clamped to AGIM_A2A_MAX_DEPTH at spawn). */
  maxDepth?: number
  /** Same-family Agim only: advertise/allow only these tool names. */
  allowedTools?: string[]
}

export type ParseCallAgentResult =
  | { ok: true; task: ParsedCallAgentTask }
  | { ok: false; error: string }

function unknownKeysError(raw: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): string | null {
  const extra = Object.keys(raw).filter((k) => !allowed.has(k))
  if (extra.length === 0) return null
  return `${path} has unknown key(s): ${extra.join(', ')}. Allowed: ${[...allowed].join(', ')}.`
}

function optionalNonEmptyString(value: unknown, field: string, path: string):
  | { ok: true; value?: string }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'string') {
    return { ok: false, error: `${path}.${field} must be a string.` }
  }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true }
  return { ok: true, value: trimmed }
}

/**
 * Fail-loud parse of one call_agent / call_agents task object.
 * Unknown keys are refused (capability seam: do not silently drop fields).
 */
export function parseCallAgentTask(
  raw: unknown,
  opts?: { extraKeys?: readonly string[]; path?: string },
): ParseCallAgentResult {
  const path = opts?.path || 'call_agent'
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${path} must be an object.` }
  }
  const rec = raw as Record<string, unknown>
  const allowed = new Set<string>([...CALL_AGENT_TASK_KEYS, ...(opts?.extraKeys ?? [])])
  const extra = unknownKeysError(rec, allowed, path)
  if (extra) return { ok: false, error: extra }

  const agent = typeof rec.agent === 'string' ? rec.agent.trim() : ''
  const prompt = typeof rec.prompt === 'string' ? rec.prompt : ''
  if (!agent || typeof rec.prompt !== 'string' || !prompt) {
    return { ok: false, error: `${path} requires both agent and prompt strings.` }
  }

  if (rec.isolate !== undefined && typeof rec.isolate !== 'boolean') {
    return { ok: false, error: `${path}.isolate must be a boolean.` }
  }

  const role = optionalNonEmptyString(rec.role, 'role', path)
  if (!role.ok) return role
  const backend = optionalNonEmptyString(rec.backend, 'backend', path)
  if (!backend.ok) return backend
  const outputFormat = optionalNonEmptyString(rec.outputFormat, 'outputFormat', path)
  if (!outputFormat.ok) return outputFormat

  let maxDepth: number | undefined
  if (rec.maxDepth !== undefined) {
    if (typeof rec.maxDepth !== 'number' || !Number.isInteger(rec.maxDepth) || rec.maxDepth < 1) {
      return { ok: false, error: `${path}.maxDepth must be an integer ≥ 1.` }
    }
    maxDepth = rec.maxDepth
  }

  let allowedTools: string[] | undefined
  if (rec.allowedTools !== undefined) {
    if (!Array.isArray(rec.allowedTools) || rec.allowedTools.length === 0) {
      return { ok: false, error: `${path}.allowedTools must be a non-empty array of tool names.` }
    }
    const names: string[] = []
    for (let i = 0; i < rec.allowedTools.length; i++) {
      const n = rec.allowedTools[i]
      if (typeof n !== 'string' || !n.trim()) {
        return { ok: false, error: `${path}.allowedTools[${i}] must be a non-empty string.` }
      }
      names.push(n.trim())
    }
    allowedTools = names
  }

  return {
    ok: true,
    task: {
      agent,
      prompt,
      ...(role.value ? { role: role.value } : {}),
      ...(backend.value ? { backend: backend.value } : {}),
      ...(rec.isolate === true ? { isolate: true } : {}),
      ...(outputFormat.value ? { outputFormat: outputFormat.value } : {}),
      ...(maxDepth != null ? { maxDepth } : {}),
      ...(allowedTools ? { allowedTools } : {}),
    },
  }
}

/** Fail-loud parse of `call_agents` root `{ tasks: [...] }`. */
export function parseCallAgentsArgs(
  raw: unknown,
  opts?: { extraTaskKeys?: readonly string[]; path?: string },
): { ok: true; tasks: ParsedCallAgentTask[] } | { ok: false; error: string } {
  const path = opts?.path || 'call_agents'
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${path} must be an object.` }
  }
  const rec = raw as Record<string, unknown>
  const extra = unknownKeysError(rec, new Set(CALL_AGENTS_ROOT_KEYS), path)
  if (extra) return { ok: false, error: extra }
  const rawTasks = rec.tasks
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return { ok: false, error: `${path} requires a non-empty \`tasks\` array.` }
  }
  const tasks: ParsedCallAgentTask[] = []
  for (let i = 0; i < rawTasks.length; i++) {
    const parsed = parseCallAgentTask(rawTasks[i], {
      extraKeys: opts?.extraTaskKeys,
      path: `${path}.tasks[${i}]`,
    })
    if (!parsed.ok) return parsed
    tasks.push(parsed.task)
  }
  return { ok: true, tasks }
}

/** Append an explicit output-format contract to the child brief. */
export function applyCallAgentOutputFormat(prompt: string, outputFormat?: string): string {
  const fmt = outputFormat?.trim()
  if (!fmt) return prompt
  return `${prompt.replace(/\s+$/, '')}\n\n[Output format]\n${fmt}`
}

/**
 * Intersect child `allowedTools` with an inherited parent allowlist.
 * Missing child list inherits the parent; empty intersection fails loud.
 */
export function intersectAllowedTools(
  parent: readonly string[] | undefined,
  child: readonly string[] | undefined,
): { ok: true; tools?: string[] } | { ok: false; error: string } {
  if (!parent?.length) {
    return { ok: true, tools: child?.length ? [...child] : undefined }
  }
  if (!child?.length) return { ok: true, tools: [...parent] }
  const allow = expandToolNameList(parent)
  const out = child.filter((n) => allow.has(n) || allow.has(canonicalizeToolName(n)))
  if (out.length === 0) {
    return {
      ok: false,
      error:
        'allowedTools is empty after intersecting with the parent allowlist. '
        + `Parent: ${parent.join(', ')}; child: ${child.join(', ')}.`,
    }
  }
  return { ok: true, tools: out }
}

/** Clamp spawn `maxDepth` to the global + inherited subtree ceiling. */
export function resolveSubtreeMaxDepth(opts: {
  requested?: number
  inherited?: number
  globalMax: number
}): { ok: true; maxDepth: number } | { ok: false; error: string } {
  const { requested, inherited, globalMax } = opts
  if (typeof requested === 'number' && requested > globalMax) {
    return {
      ok: false,
      error: `maxDepth ${requested} exceeds AGIM_A2A_MAX_DEPTH ${globalMax}`,
    }
  }
  if (typeof requested === 'number' && typeof inherited === 'number' && requested > inherited) {
    return {
      ok: false,
      error: `maxDepth ${requested} exceeds inherited subtree cap ${inherited}`,
    }
  }
  return {
    ok: true,
    maxDepth: Math.min(globalMax, requested ?? globalMax, inherited ?? globalMax),
  }
}

export type ResolvedSubagentSpawn =
  | {
      ok: true
      agent: string
      /** Backend name for Agim Agent (`AgentSendOpts.model`). */
      model?: string
      role?: string
      /** True when this is a same-agent nested spawn (must pass A2A self-call gate). */
      isolate: boolean
      /** Same registry agent as the caller (incl. agim/native aliases). */
      sameAgent: boolean
      /** UI / activity label, e.g. `agim/cheap` or `claude-code`. */
      label: string
    }
  | { ok: false; error: string }

/** True when caller and target resolve to the same registered agent. */
export function isSameAgent(callerAgent: string, targetAgent: string): boolean {
  if (!callerAgent || !targetAgent) return false
  if (callerAgent === targetAgent) return true
  if (normalizeAgentId(callerAgent) === normalizeAgentId(targetAgent)) return true
  if (isAgimAgentId(callerAgent) && isAgimAgentId(targetAgent)) return true
  const a = registry.findAgent(callerAgent)
  const b = registry.findAgent(targetAgent)
  return !!(a && b && a.name === b.name)
}

/** Case-insensitive backend name lookup → canonical name. */
export function resolveBackendName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (getBackendBindingByName(trimmed) || getProviderByName(trimmed)) return trimmed
  const lower = trimmed.toLowerCase()
  for (const p of listProviders()) {
    if (p.name.toLowerCase() === lower) return p.name
  }
  return null
}

export function formatSubagentLabel(
  agent: string,
  opts?: { role?: string; backend?: string },
): string {
  const base = isAgimAgentId(agent) ? 'agim' : agent
  if (opts?.role) return `${base}/${opts.role}`
  if (opts?.backend) return `${base}:${opts.backend}`
  return base
}

function availableBackendsHint(): string {
  const names = listProviders().map((p) => p.name)
  if (names.length === 0) {
    return 'No llmBackends are configured yet (Settings → LLM).'
  }
  return `Configured backends: ${names.join(', ')}.`
}

function availableRolesHint(): string {
  const roles = Object.keys(describeRegistry().roles)
  if (roles.length === 0) return 'No llmRoles aliases are configured.'
  return `Configured roles: ${roles.join(', ')}.`
}

/**
 * Resolve call_agent / spawn_subagent arguments into a concrete target.
 * Same-agent calls require isolate, role, or backend (vacuous self-call rejected).
 *
 * Prefer `backend` (concrete llmBackends.name). `role` is an optional alias
 * (e.g. cheap) and fails closed when unbound — do not assume cheap exists.
 */
export function resolveSubagentSpawn(
  input: SubagentSpawnInput,
  callerAgent: string,
): ResolvedSubagentSpawn {
  const rawAgent = typeof input.agent === 'string' ? input.agent.trim() : ''
  if (!rawAgent) return { ok: false, error: 'agent is required' }

  const parsed = parseCallAgentTarget(rawAgent)
  const agent = parsed.agent
  if (!agent) return { ok: false, error: 'agent is required' }

  const roleRaw = typeof input.role === 'string' ? input.role.trim() : ''
  const backendRaw = typeof input.backend === 'string' ? input.backend.trim() : ''
  // Explicit tool args win; slash/colon form fills gaps.
  // If both role and backend appear from mixed sources, backend wins.
  const backend = backendRaw || parsed.backend || undefined
  const role = backend ? undefined : (roleRaw || parsed.role || undefined)
  const isolateFlag = input.isolate === true || parsed.isolate === true

  let model: string | undefined
  if (backend) {
    const resolved = resolveBackendName(backend)
    if (!resolved) {
      return {
        ok: false,
        error:
          `backend "${backend}" not found or has no usable API key. ` +
          `${availableBackendsHint()} ` +
          `Prefer call_agent({ agent:"agim", backend:"<name>", … }) with a configured backend name, ` +
          `or isolate:true to reuse the parent default model. ` +
          `${availableRolesHint()}`,
      }
    }
    model = resolved
  } else if (role) {
    const binding = getBackendBindingForRole(role)
    if (!binding) {
      return {
        ok: false,
        error:
          `llmRoles.${role} is not configured or its backend is unusable. ` +
          `${availableRolesHint()} ${availableBackendsHint()} ` +
          `Prefer backend:"<llmBackends.name>" (concrete) over role aliases, ` +
          `or use isolate:true to reuse the parent default model.`,
      }
    }
    model = binding.name
  }

  const sameAgent = isSameAgent(callerAgent, agent)
  const isolate = isolateFlag || !!role || !!backend || !!model

  if (sameAgent && !isolate) {
    return {
      ok: false,
      error:
        `cannot call self (${agent}) without isolate/role/backend. ` +
        `For a same-family Subagent: pass isolate:true (reuse default model), ` +
        `backend:"<llmBackends.name>" (preferred), or role:"cheap" only when llmRoles.cheap is set. ` +
        `To switch the user's sticky agent, tell them to use /cc /oc /agim etc.`,
    }
  }

  return {
    ok: true,
    agent,
    model,
    role,
    isolate: sameAgent ? true : isolateFlag,
    sameAgent,
    label: formatSubagentLabel(agent, { role, backend: model }),
  }
}
