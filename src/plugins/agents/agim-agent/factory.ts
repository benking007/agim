// Wires the production Agim Agent adapter: real provider resolution off
// agim's LLM registry + durable session storage under AGIM_HOME. Kept separate
// from index.ts so the adapter class stays free of registry/path coupling
// (and unit-testable with injected deps).

import { chmodSync, mkdirSync } from 'node:fs'
import { resolveAgentCwd, defaultAgentCwd } from '../../../core/agent-cwd.js'
import { AGIM_HOME } from '../../../core/agim-paths.js'
import {
  configureAgimAgentSessionLifecycle,
  startAgimAgentSessionRetention,
} from '../../../core/agim-agent-session-lifecycle.js'
import { migratePiSessionsDir } from '../../../core/naming-migrate.js'
import { threadKey as makeThreadKey } from '../../../core/approval-bus.js'
import { applyGoalTimeoutBoost } from '../../../core/goals.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { getAnyProvider, getProvider, getProviderByName, listProviders } from '../../../core/llm/registry.js'
import { buildSystemPrompt } from '../agim-agent-shared/index.js'
import { buildPiApprovalGate } from './approval.js'
import { isContextCompactionEnabled } from './context-budget.js'
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

function resolveMaxToolCalls(): number {
  const raw = process.env.AGIM_NATIVE_AGENT_MAX_TOOL_CALLS
  if (!raw?.trim()) return 50
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(n, 1000)
}

/** Positive-integer env override, else the given default. */
function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (!raw?.trim()) return def
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : def
}

/** Whole active AgentHarness-loop watchdog. Compaction runs before this timer
 * because pi 0.79.x does not expose an external compaction signal. */
function resolveRunTimeoutMs(opts: AgentSendOpts | undefined): number {
  // Match the longest built-in interactive approval window so a legitimate
  // Plan Mode confirmation is not killed before the user can answer.
  const base = envInt('AGIM_NATIVE_TURN_TIMEOUT_MS', 15 * 60 * 1000)
  if (base === 0) return 0
  return applyGoalTimeoutBoost(base, {
    platform: opts?.platform,
    channelId: opts?.channelId,
    threadId: opts?.threadId,
  })
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
  const sessionsRoot = migratePiSessionsDir(AGIM_HOME)
  try {
    mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 })
    chmodSync(sessionsRoot, 0o700)
  } catch (err) {
    console.error('[agim-agent] failed to secure session root:', err instanceof Error ? err.message : err)
  }
  const adapter = new NativeAgentAdapter({
    name: 'agim',
    aliases: ['native', 'na', 'llm', 'native-llm', 'agim-agent'],
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
    maxToolCalls: resolveMaxToolCalls(),
    // Proactive per-turn compaction (pi never auto-compacts). On by default;
    // AGIM_CTX_COMPACT=off disables it (legacy alias: AGIM_NATIVE_COMPACTION).
    compactionEnabled: isContextCompactionEnabled(),
    // Provider retry/backoff/timeout + prompt cache (rides out transient LLM
    // 429/5xx and cuts repeat token cost). All AGIM_NATIVE_* env-overridable.
    streamOptions: resolveStreamOptions(),
    resolveRunTimeoutMs,
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
          const cwd = resolveAgentCwd('agim', o) || defaultAgentCwd('agim')
          return buildSystemPrompt(provider, `backend:${provider.name}`, cwd, planThreadKey)
        }
      }
      for (const role of ROLE_CHAIN) {
        const provider = getProvider(role)
        if (!provider) continue
        const planThreadKey =
          o.platform && o.threadId ? makeThreadKey(o.platform, o.channelId ?? '', o.threadId) : undefined
        const cwd = resolveAgentCwd('agim', o) || defaultAgentCwd('agim')
        return buildSystemPrompt(provider, role, cwd, planThreadKey)
      }
      const fallback = getAnyProvider()
      if (fallback) {
        const planThreadKey =
          o.platform && o.threadId ? makeThreadKey(o.platform, o.channelId ?? '', o.threadId) : undefined
        const cwd = resolveAgentCwd('agim', o) || defaultAgentCwd('agim')
        return buildSystemPrompt(fallback, 'auto', cwd, planThreadKey)
      }
      return undefined
    },
  })

  // Wire /new · switch · META TTL → quarantine. Boot orphan inventory is
  // started from the CLI after sessionManager.start() so unit-test imports
  // of this module do not scan the operator's real AGIM_HOME.
  configureAgimAgentSessionLifecycle({
    sessionsRoot,
    hooks: {
      isBusy: (id) => adapter.isSessionBusy(id),
      invalidateCache: (id) => adapter.invalidateSessionMeta(id),
    },
  })
  startAgimAgentSessionRetention({ runBootInventory: false })

  return adapter
}

export const nativeAgentAdapter = createNativeAgentAdapter()
