// Wires the production PiNativeAgentAdapter: real provider resolution off
// agim's LLM registry + durable session storage under AGIM_HOME. Kept separate
// from index.ts so the adapter class stays free of registry/path coupling
// (and unit-testable with injected deps).

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AGIM_HOME } from '../../../core/agim-paths.js'
import { PiNativeAgentAdapter } from './index.js'
import { resolvePiModelForRole } from './provider-resolver.js'

// Same role precedence the legacy native adapter uses (native/index.ts).
const ROLE_CHAIN = ['native-chat', 'cheap']

export function createPiNativeAdapter(): PiNativeAgentAdapter {
  const sessionsRoot = join(AGIM_HOME, 'pi-sessions')
  try {
    mkdirSync(sessionsRoot, { recursive: true })
  } catch {
    /* best-effort; sendPrompt surfaces a clear error if the dir is unusable */
  }
  return new PiNativeAgentAdapter({
    sessionsRoot,
    resolveModel: async () => {
      for (const role of ROLE_CHAIN) {
        const binding = resolvePiModelForRole(role)
        if (binding) return binding
      }
      return null
    },
    // resolveTools: follow-up — wire agim's native tool assembly (imhub /
    // builtin / MCP dispatchers). Chat-only until then.
  })
}

/** Singleton registered by the plugin registry when IMHUB_NATIVE_ENGINE=pi. */
export const piNativeAgentAdapter = createPiNativeAdapter()
