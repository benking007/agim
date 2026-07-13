// live-config — singleton holding the current in-process Config.
//
// Why this exists (v1.2.103):
//   Before this module, three subsystems captured `config.defaultAgent`
//   at boot time as a value snapshot:
//     - startWebServer(options.defaultAgent)
//     - startACPServer(options.defaultAgent)
//     - cli.ts onMessage → routeCtx.defaultAgent = config.defaultAgent
//   The PUT /api/config endpoint persisted changes to disk but never
//   refreshed those snapshots, so flipping the default Agent in the SPA
//   only took effect after a service restart.
//
//   Similarly, `config.agents[]` (the SPA's enable / disable toggle for
//   each built-in agent) was persisted but never consulted by
//   registry.findAgent / listAgents. Disabling 'codex' in the SPA
//   silently did nothing — the agent stayed routable + counted toward
//   intent classification.
//
// Contract:
//   - setLiveConfig() is the single mutation point. cli.ts calls it
//     once at boot; PUT /api/config calls it again after every save.
//   - getLiveConfig() returns the most recently set Config or `null`
//     (very early boot, before cli.ts has finished loading config).
//   - getDefaultAgent() / isAgentEnabled() encode the policy callers
//     want — they never expose the raw Config and they degrade to safe
//     defaults when no config is loaded yet.
//
//   Empty `agents: []` (legacy installs that never configured the list)
//   is treated as "all installed agents enabled" — back-compat. Only an
//   explicit non-empty list filters.

import type { Config } from './types.js'

let current: Config | null = null

/** Replace the live config. Called once at boot, then again on every
 *  successful PUT /api/config. */
export function setLiveConfig(cfg: Config): void {
  current = cfg
}

/** Return the live Config or null if not yet set. Most callers should
 *  use the typed accessors below instead of inspecting raw fields. */
export function getLiveConfig(): Config | null {
  return current
}

/** The Config's `defaultAgent` field, with a fallback for very early
 *  callers (e.g. a tool fires before cli.ts has finished boot). */
export function getDefaultAgent(fallback = 'agim'): string {
  return current?.defaultAgent || fallback
}

/** True iff `name` is in the operator's enabled-agent list. Empty list
 *  or no-config-loaded → "allow all" for back-compat with installs that
 *  never configured the list explicitly.
 *
 *  `agim` / legacy `native` are treated as the same agent id. */
export function isAgentEnabled(name: string): boolean {
  if (!current) return true
  const list = current.agents
  if (!list || list.length === 0) return true
  const defaultId = current.defaultAgent || ''
  if (name === defaultId) return true
  // Agim Agent: accept either registry id while configs migrate.
  if ((name === 'agim' || name === 'native')
    && (list.includes('agim') || list.includes('native') || defaultId === 'agim' || defaultId === 'native')) {
    return true
  }
  if (name === 'agim' && list.includes('native')) return true
  if (name === 'native' && list.includes('agim')) return true
  return list.includes(name)
}

/** Visible for test. Resets the singleton between tests. NOT exposed
 *  through index/barrel exports — runtime callers should never reach
 *  for this. */
export function __resetLiveConfigForTest(): void {
  current = null
}
