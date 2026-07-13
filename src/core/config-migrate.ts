// One-shot config migrations applied at boot (and from tests).
//
// Keep each migration idempotent via an explicit flag on the config object
// so re-runs after the operator intentionally changes the migrated field
// do not undo their choice.
//
// Naming v2 (registry id / tenants) lives in naming-migrate.ts and is
// composed via migrateNamingV2().

import type { Config } from './types.js'

/**
 * Honour SPA `config.agents` disable for Agim Agent.
 *
 * Historical installs never listed the built-in agent (runtime always
 * allowed it). Before treating absence as a hard disable, append the
 * canonical id (`agim`, with legacy `native` accepted during rewrite)
 * once to any non-empty enabled list that omits both, then set
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
  const hasBuiltin = list.includes('agim') || list.includes('native')
  if (list.length > 0 && !hasBuiltin) {
    next.agents = [...list, 'agim']
  }
  return { config: next, changed: true }
}
