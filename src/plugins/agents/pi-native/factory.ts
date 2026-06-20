// Wires the production PiNativeAgentAdapter: real provider resolution off
// agim's LLM registry + durable session storage under AGIM_HOME. Kept separate
// from index.ts so the adapter class stays free of registry/path coupling
// (and unit-testable with injected deps).

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AGIM_HOME } from '../../../core/agim-paths.js'
import { buildPiApprovalGate } from './approval.js'
import { PiNativeAgentAdapter } from './index.js'
import { resolvePiModelForRole } from './provider-resolver.js'
import { assembleToolsForPi } from './tools.js'

// Same role precedence the legacy native adapter uses (native/index.ts).
const ROLE_CHAIN = ['native-chat', 'cheap']

/** Mirror agim's IMHUB_NATIVE_AGENT_MAX_ITER (default 50, clamp [1,100]). */
function resolveMaxIterations(): number {
  const raw = process.env.IMHUB_NATIVE_AGENT_MAX_ITER
  if (!raw?.trim()) return 50
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(n, 100)
}

export function createPiNativeAdapter(): PiNativeAgentAdapter {
  const sessionsRoot = join(AGIM_HOME, 'pi-sessions')
  try {
    mkdirSync(sessionsRoot, { recursive: true })
  } catch {
    /* best-effort; sendPrompt surfaces a clear error if the dir is unusable */
  }
  return new PiNativeAgentAdapter({
    // pi is the default engine: register under the 'native' name AND inherit
    // the legacy native adapter's aliases (llm / native-llm / na) so existing
    // muscle memory (`/na`, `/llm`) keeps working transparently, plus pi names.
    name: 'native',
    aliases: ['na', 'llm', 'native-llm', 'pi', 'pi-native'],
    sessionsRoot,
    resolveModel: async () => {
      for (const role of ROLE_CHAIN) {
        const binding = resolvePiModelForRole(role)
        if (binding) return binding
      }
      return null
    },
    // Full agim tool surface (builtin / fs / web / exec / todo / imhub / MCP),
    // assembled per-turn from native's single source of truth.
    resolveTools: (opts, sessionId) => assembleToolsForPi(opts, sessionId),
    // Same policy gating as legacy native (read-only / allow-list / plan-mode /
    // IM approval card).
    resolveApprovalGate: (opts, sessionId) => buildPiApprovalGate(opts, sessionId),
    maxIterations: resolveMaxIterations(),
  })
}

/** Singleton registered by the plugin registry when IMHUB_NATIVE_ENGINE=pi. */
export const piNativeAgentAdapter = createPiNativeAdapter()
