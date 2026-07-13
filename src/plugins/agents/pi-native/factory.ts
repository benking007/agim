// Wires the production Agim Agent adapter: real provider resolution off
// agim's LLM registry + durable session storage under AGIM_HOME. Kept separate
// from index.ts so the adapter class stays free of registry/path coupling
// (and unit-testable with injected deps).

import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAgentCwd, defaultAgentCwd } from '../../../core/agent-cwd.js'
import { AGIM_HOME } from '../../../core/agim-paths.js'
import { threadKey as makeThreadKey } from '../../../core/approval-bus.js'
import { getAnyProvider, getProvider, getProviderByName, listProviders } from '../../../core/llm/registry.js'
import { buildSystemPrompt } from '../native/index.js'
import { buildPiApprovalGate } from './approval.js'
import { NativeAgentAdapter } from './index.js'
import { resolveAnyPiModel, resolvePiModelByBackendName, resolvePiModelForRole } from './provider-resolver.js'
import { assembleToolsForPi } from './tools.js'

const ROLE_CHAIN = ['native-chat', 'cheap']

/** Mirror agim's AGIM_NATIVE_AGENT_MAX_ITER (default 50, clamp [1,100]). */
function resolveMaxIterations(): number {
  const raw = process.env.AGIM_NATIVE_AGENT_MAX_ITER
  if (!raw?.trim()) return 50
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(n, 100)
}

/** Positive-integer env override, else the given default. */
function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (!raw?.trim()) return def
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : def
}

/** Provider resilience + prompt-cache options, all env-overridable. Defaults:
 *  2 retries, 20s retry-delay cap, 120s/request timeout, 'short' cache. */
function resolveStreamOptions() {
  const raw = (process.env.AGIM_NATIVE_CACHE_RETENTION ?? 'short').trim()
  const cacheRetention = (['none', 'short', 'long'] as const).find((v) => v === raw) ?? 'short'
  return {
    maxRetries: envInt('AGIM_NATIVE_MAX_RETRIES', 2),
    maxRetryDelayMs: envInt('AGIM_NATIVE_MAX_RETRY_DELAY_MS', 20_000),
    timeoutMs: envInt('AGIM_NATIVE_REQUEST_TIMEOUT_MS', 120_000),
    cacheRetention,
  }
}

export function createNativeAgentAdapter(): NativeAgentAdapter {
  const sessionsRoot = join(AGIM_HOME, 'pi-sessions')
  try {
    mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 })
    // mkdir's mode does not tighten an existing directory. Enforce the
    // private-state boundary on every startup (best-effort on non-POSIX).
    chmodSync(sessionsRoot, 0o700)
  } catch {
    /* best-effort; sendPrompt surfaces a clear error if the dir is unusable */
  }
  return new NativeAgentAdapter({
    name: 'native',
    aliases: ['agim', 'na', 'llm', 'native-llm'],
    sessionsRoot,
    resolveModel: async (opts) => {
      const explicit = resolvePiModelByBackendName(opts?.model)
      if (explicit) return explicit
      for (const role of ROLE_CHAIN) {
        const binding = resolvePiModelForRole(role)
        if (binding) return binding
      }
      return resolveAnyPiModel()
    },
    listModels: () => listProviders().map((p) => ({
      name: p.name,
      providerType: p.providerType,
      model: p.model,
    })),
    // Full agim tool surface (builtin / fs / web / exec / todo / agim / MCP),
    // assembled per-turn from native's single source of truth.
    resolveTools: (opts, sessionId) => assembleToolsForPi(opts, sessionId),
    // Same policy gating as the public Agim Agent contract (read-only /
    // allow-list / plan-mode / IM approval card).
    resolveApprovalGate: (opts, sessionId) => buildPiApprovalGate(opts, sessionId),
    maxIterations: resolveMaxIterations(),
    // Proactive per-turn compaction (pi never auto-compacts). On by default;
    // AGIM_NATIVE_COMPACTION=off disables it.
    compactionEnabled: process.env.AGIM_NATIVE_COMPACTION !== 'off',
    // Provider retry/backoff/timeout + prompt cache (rides out transient LLM
    // 429/5xx and cuts repeat token cost). All AGIM_NATIVE_* env-overridable.
    streamOptions: resolveStreamOptions(),
    // Reuse native's full system prompt so the model knows its real backend +
    // model + role (fixes "what model are you" → it stops hallucinating claude)
    // and gets the operator role + skill routing + tool guides.
    resolveSystemPrompt: (opts) => {
      const o = opts ?? {}
      if (o.model) {
        const provider = getProviderByName(o.model)
        if (provider) {
          const planThreadKey =
            o.platform && o.threadId ? makeThreadKey(o.platform, o.channelId ?? '', o.threadId) : undefined
          const cwd = resolveAgentCwd('native', o) || defaultAgentCwd('native')
          return buildSystemPrompt(provider, `backend:${provider.name}`, cwd, planThreadKey)
        }
      }
      for (const role of ROLE_CHAIN) {
        const provider = getProvider(role)
        if (!provider) continue
        const planThreadKey =
          o.platform && o.threadId ? makeThreadKey(o.platform, o.channelId ?? '', o.threadId) : undefined
        const cwd = resolveAgentCwd('native', o) || defaultAgentCwd('native')
        return buildSystemPrompt(provider, role, cwd, planThreadKey)
      }
      const fallback = getAnyProvider()
      if (fallback) {
        const planThreadKey =
          o.platform && o.threadId ? makeThreadKey(o.platform, o.channelId ?? '', o.threadId) : undefined
        const cwd = resolveAgentCwd('native', o) || defaultAgentCwd('native')
        return buildSystemPrompt(fallback, 'auto', cwd, planThreadKey)
      }
      return undefined
    },
  })
}

export const nativeAgentAdapter = createNativeAgentAdapter()
