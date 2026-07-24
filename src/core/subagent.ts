// Subagent spawn helpers — same-family (agim + role/backend) and
// cross-adapter targets share one resolution path before A2A / activity.
// Concept SSOT: docs/architecture/subagent.md

import { isAgimAgentId, normalizeAgentId } from './naming-migrate.js'
import { registry } from './registry.js'
import {
  getBackendBindingByName,
  getBackendBindingForRole,
  getProviderByName,
  listProviders,
} from './llm/registry.js'

export interface SubagentSpawnInput {
  agent: string
  /** llmRoles key, e.g. `cheap` → flash */
  role?: string
  /** Explicit llmBackends name */
  backend?: string
  /** Allow same-agent nested spawn with isolated context (same or default model). */
  isolate?: boolean
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

/**
 * Resolve call_agent / spawn_subagent arguments into a concrete target.
 * Same-agent calls require isolate, role, or backend (vacuous self-call rejected).
 */
export function resolveSubagentSpawn(
  input: SubagentSpawnInput,
  callerAgent: string,
): ResolvedSubagentSpawn {
  const agent = typeof input.agent === 'string' ? input.agent.trim() : ''
  if (!agent) return { ok: false, error: 'agent is required' }

  const roleRaw = typeof input.role === 'string' ? input.role.trim() : ''
  const backendRaw = typeof input.backend === 'string' ? input.backend.trim() : ''
  const role = roleRaw || undefined
  const backend = backendRaw || undefined
  const isolateFlag = input.isolate === true

  let model: string | undefined
  if (backend) {
    const resolved = resolveBackendName(backend)
    if (!resolved) {
      return {
        ok: false,
        error:
          `backend "${backend}" not found or has no usable API key. ` +
          `Add it under Settings → LLM (llmBackends + llm-secrets), or omit backend to use the default.`,
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
          `Configure a cheap/flash backend and bind llmRoles.${role}, or pass backend explicitly, ` +
          `or use isolate:true to reuse the parent default model.`,
      }
    }
    model = binding.name
  }

  const sameAgent = isSameAgent(callerAgent, agent)
  const isolate = isolateFlag || !!role || !!backend

  if (sameAgent && !isolate) {
    return {
      ok: false,
      error:
        `cannot call self (${agent}) without isolate/role/backend. ` +
        `For a same-family Subagent: pass isolate:true (reuse default model), ` +
        `role:"cheap" (llmRoles.cheap), or backend:"<llmBackends.name>". ` +
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
