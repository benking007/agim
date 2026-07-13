// One-shot config migrations applied at boot (and from tests).
//
// Keep each migration idempotent via an explicit flag on the config object
// so re-runs after the operator intentionally changes the migrated field
// do not undo their choice.

import type { Config } from './types.js'

/**
 * Honour SPA `config.agents` disable for `native`.
 *
 * Historical installs never listed `native` (runtime always allowed it).
 * Before treating absence as a hard disable, append `native` once to any
 * non-empty enabled list that omits it, then set
 * `nativeAgentToggleMigrated` so later operator removals stick.
 *
 * Empty `agents: []` stays "allow all" and only gets the flag — a later
 * first explicit list is treated as intentional.
 */
export function migrateNativeAgentToggle(config: Config): {
  config: Config
  changed: boolean
} {
  if (config.nativeAgentToggleMigrated === true) {
    return { config, changed: false }
  }

  const list = Array.isArray(config.agents) ? config.agents : []
  const next: Config = {
    ...config,
    nativeAgentToggleMigrated: true,
  }
  if (list.length > 0 && !list.includes('native')) {
    next.agents = [...list, 'native']
  }
  return { config: next, changed: true }
}
